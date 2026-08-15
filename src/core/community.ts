import { randomUUID } from "node:crypto";
import { registerActiveContext, releaseActiveContext } from "./active-context";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonStore, updateJsonStore, writeJsonFileAtomic } from "./json-store";

export type IssueStatus = "open" | "triage" | "forming" | "executing" | "reviewing" | "resolved" | "blocked";
export interface IssueComment { id: string; author: string; body: string; createdAt: string; }
export interface IssueClaim { id: string; agent: string; scope: string; status: "active" | "submitted" | "reviewed"; createdAt: string; }
export type IssueEventType =
	| "created" | "commented" | "claimed" | "submitted"
	| "reviewed" | "reworked" | "resolved" | "blocked" | "unblocked";
export interface IssueEvent { id: string; type: IssueEventType; actor: string; detail: string; createdAt: string; }
export interface CommunityIssue {
	id: string;
	title: string;
	description: string;
	status: IssueStatus;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
	acceptanceCriteria: string[];
	comments: IssueComment[];
	claims: IssueClaim[];
	timeline: IssueEvent[];
}

interface IssueStore { issues: CommunityIssue[]; }

/**
 * 早期 Community 版本的 issues.json 是顶层数组格式，缺少 description/
 * createdBy/acceptanceCriteria/comments/claims 等字段。read/update 检测到该
 * 格式时先迁移为当前 IssueStore 结构并原子写回（保留 .bak 备份），确保旧数据
 * 不丢失、不阻塞后续读写；迁移逻辑与 task-registry 的 v1→v2 兼容保持一致。
 */
interface LegacyIssueRecord {
	id?: string;
	title: string;
	description?: string;
	status?: string;
	priority?: string;
	created?: number;
	updated?: number;
	tags?: string[];
}

function isLegacyIssueArray(value: unknown): value is LegacyIssueRecord[] {
	return Array.isArray(value)
		&& value.every(record => !!record && typeof record === "object"
			&& typeof (record as LegacyIssueRecord).title === "string");
}

const LEGACY_STATUS: Record<string, IssueStatus> = {
	open: "open",
	triage: "triage",
	forming: "forming",
	executing: "executing",
	reviewing: "reviewing",
	resolved: "resolved",
	closed: "resolved",
	blocked: "blocked",
};

function migrateLegacyIssues(records: LegacyIssueRecord[]): CommunityIssue[] {
	const now = new Date().toISOString();
	return records.map(record => ({
		id: record.id ?? `issue-migrated-${randomUUID()}`,
		title: record.title.trim(),
		description: record.description?.trim() ?? [
			record.priority ? `priority: ${record.priority}` : "",
			(record.tags?.length ? `tags: ${record.tags.join(", ")}` : ""),
		].filter(Boolean).join("\n"),
		status: LEGACY_STATUS[record.status ?? "open"] ?? "open",
		createdBy: "main",
		createdAt: record.created ? new Date(record.created).toISOString() : now,
		updatedAt: record.updated ? new Date(record.updated).toISOString() : now,
		acceptanceCriteria: [],
		comments: [],
		claims: [],
		timeline: [],
	}));
}

function pathFor(cwd: string): string { return join(cwd, ".agentflux", "issues.json"); }
const createStore = (): IssueStore => ({ issues: [] });
const isStore = (value: unknown): value is IssueStore =>
	!!value && typeof value === "object" && Array.isArray((value as IssueStore).issues);
function read(cwd: string): IssueStore {
	const path = pathFor(cwd);
	if (!existsSync(path)) return createStore();
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		throw new Error(`JSON store is corrupt and was not overwritten: ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (isLegacyIssueArray(raw)) {
		const store: IssueStore = { issues: migrateLegacyIssues(raw) };
		writeJsonFileAtomic(path, store);
		return store;
	}
	if (!isStore(raw)) throw new Error(`JSON store schema is invalid and was not overwritten: ${path}`);
	return raw;
}
function update<R>(cwd: string, action: (store: IssueStore) => R): R {
	// 旧格式文件先经 read() 迁移并写回，updateJsonStore 才能通过 schema 校验。
	read(cwd);
	return updateJsonStore(pathFor(cwd), createStore, isStore, action);
}

/** 终态守卫: resolved 后的 issue 不可再变更 (与 Task Registry 的不可变终态一致)。 */
function assertMutable(issue: CommunityIssue): void {
	if (issue.status === "resolved") throw new Error(`Issue is already resolved and immutable: ${issue.id}`);
}

function appendEvent(issue: CommunityIssue, type: IssueEventType, actor: string, detail: string): void {
	if (!issue.timeline) issue.timeline = [];
	issue.timeline.push({ id: `evt-${randomUUID()}`, type, actor, detail, createdAt: new Date().toISOString() });
}

/** 非终态 issue 的确定性下一步（状态机推导，不依赖 LLM）。 */
export function nextActions(issue: CommunityIssue): string[] {
	if (issue.status === "resolved") return [];
	if (issue.status === "reviewing") {
		const pending = issue.claims.filter(claim => claim.status === "submitted");
		const reviewedAll = issue.claims.length > 0 && issue.claims.every(claim => claim.status === "reviewed");
		if (pending.length > 0) return ["review claim: flux_issue review <id> <claimId> pass|rework [feedback]"];
		if (reviewedAll) return ["resolve issue: flux_issue resolve <id>"];
		return [];
	}
	if (issue.status === "executing" || issue.status === "open" || issue.status === "forming" || issue.status === "blocked") {
		const active = issue.claims.filter(claim => claim.status === "active");
		if (active.length > 0) return ["submit claim: flux_issue submit <id> <claimId>"];
		return ["claim scope: flux_issue claim <id> <agent> <scope>"];
	}
	return [];
}

export function listIssues(cwd: string): CommunityIssue[] { return read(cwd).issues; }
export function getIssue(cwd: string, id: string): CommunityIssue | undefined { return read(cwd).issues.find(issue => issue.id === id); }
export function createIssue(cwd: string, input: { title: string; description: string; createdBy?: string; acceptanceCriteria?: string[] }): CommunityIssue {
	if (!input.title.trim()) throw new Error("Issue title cannot be empty");
	const now = new Date().toISOString();
	const issue: CommunityIssue = { id: `issue-${randomUUID()}`, title: input.title.trim(), description: input.description.trim(), status: "open", createdBy: input.createdBy ?? "main", createdAt: now, updatedAt: now, acceptanceCriteria: input.acceptanceCriteria ?? [], comments: [], claims: [], timeline: [] };
	return update(cwd, store => { store.issues.push(issue); appendEvent(issue, "created", issue.createdBy, input.title.trim()); return issue; });
}
export function commentOnIssue(cwd: string, id: string, author: string, body: string): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); assertMutable(issue); issue.comments.push({ id: `comment-${randomUUID()}`, author, body: body.trim(), createdAt: new Date().toISOString() }); issue.updatedAt = new Date().toISOString(); appendEvent(issue, "commented", author, body.trim().slice(0, 120)); return issue; }); }
export function claimIssue(cwd: string, id: string, agent: string, scope: string): CommunityIssue {
	registerActiveContext(cwd, { name: `issue:${id}`, context: "community", scope: id, task: `claim ${agent} → ${scope}` });
	try {
		return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); assertMutable(issue); if (issue.claims.some(claim => claim.status === "active" && claim.scope === scope)) throw new Error(`Scope already claimed: ${scope}`); const claim = { id: `claim-${randomUUID()}`, agent, scope, status: "active" as const, createdAt: new Date().toISOString() }; issue.claims.push(claim); issue.status = "executing"; issue.updatedAt = new Date().toISOString(); appendEvent(issue, "claimed", agent, `${claim.id} → ${scope}`); return issue; });
	} catch (error) {
		releaseActiveContext(cwd, `issue:${id}`);
		throw error;
	}
}
export function submitClaim(cwd: string, id: string, claimId: string): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); assertMutable(issue); const claim = issue.claims.find(item => item.id === claimId); if (!claim) throw new Error(`Claim not found: ${claimId}`); if (claim.status !== "active") throw new Error(`Claim is not active: ${claimId}`); claim.status = "submitted"; issue.status = "reviewing"; issue.updatedAt = new Date().toISOString(); appendEvent(issue, "submitted", claim.agent, claimId); return issue; }); }
export function reviewClaim(cwd: string, id: string, claimId: string, verdict: "pass" | "rework", reviewer: string, feedback = ""): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); assertMutable(issue); const claim = issue.claims.find(item => item.id === claimId); if (!claim) throw new Error(`Claim not found: ${claimId}`); if (claim.status !== "submitted") throw new Error(`Claim is not in review: ${claimId} (status=${claim.status})`); if (verdict === "pass") {
		claim.status = "reviewed";
		appendEvent(issue, "reviewed", reviewer, `${claimId} ${feedback ? `· ${feedback.slice(0, 120)}` : ""}`.trim());
	} else {
		claim.status = "active";
		issue.status = "executing";
		appendEvent(issue, "reworked", reviewer, `${claimId} ${feedback ? `· ${feedback.slice(0, 120)}` : ""}`.trim());
	}
	issue.updatedAt = new Date().toISOString(); return issue; }); }
/** 删除已结束的 Issue（resolved 或 open 且无 active claim）；有活跃认领的拒绝。 */
export function deleteIssue(cwd: string, id: string): CommunityIssue {
	return update(cwd, store => {
		const index = store.issues.findIndex(item => item.id === id);
		if (index < 0) throw new Error(`Issue not found: ${id}`);
		const issue = store.issues[index];
		if (issue.claims.some(claim => claim.status === "active" || claim.status === "submitted")) {
			throw new Error(`Issue has active or submitted claims: ${id}`);
		}
		if (issue.status !== "resolved" && issue.status !== "open") {
			throw new Error(`Only resolved or open issues can be deleted (${issue.status}): ${id}`);
		}
		store.issues.splice(index, 1);
		return issue;
	});
}

export function resolveIssue(cwd: string, id: string): CommunityIssue { const issue = update(cwd, store => { const item = store.issues.find(item => item.id === id); if (!item) throw new Error(`Issue not found: ${id}`); assertMutable(item); if (item.claims.some(claim => claim.status === "active" || claim.status === "submitted")) throw new Error("Issue has active or submitted claims"); item.status = "resolved"; item.updatedAt = new Date().toISOString(); appendEvent(item, "resolved", "main", id); return item; }); releaseActiveContext(cwd, `issue:${id}`); return issue; }
export function formatIssue(issue: CommunityIssue): string { return [`${issue.id} · ${issue.status} · ${issue.title}`, issue.description, `claims ${issue.claims.length} · comments ${issue.comments.length}`, ...issue.claims.map(claim => `  ${claim.id} · ${claim.status} ${claim.agent} → ${claim.scope}`), ...(nextActions(issue).map(action => `next: ${action}`))].filter(Boolean).join("\n"); }
export function formatIssueTimeline(issue: CommunityIssue): string {
	const events = issue.timeline ?? [];
	if (events.length === 0) return "(no timeline)";
	return events.map(event => `  [${event.type}] ${event.actor} · ${event.detail} @ ${event.createdAt}`).join("\n");
}
