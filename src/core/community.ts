import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonStore, updateJsonStore, writeJsonFileAtomic } from "./json-store";

export type IssueStatus = "open" | "triage" | "forming" | "executing" | "reviewing" | "resolved" | "blocked";
export interface IssueComment { id: string; author: string; body: string; createdAt: string; }
export interface IssueClaim { id: string; agent: string; scope: string; status: "active" | "submitted" | "reviewed"; createdAt: string; }
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

export function listIssues(cwd: string): CommunityIssue[] { return read(cwd).issues; }
export function getIssue(cwd: string, id: string): CommunityIssue | undefined { return read(cwd).issues.find(issue => issue.id === id); }
export function createIssue(cwd: string, input: { title: string; description: string; createdBy?: string; acceptanceCriteria?: string[] }): CommunityIssue {
	if (!input.title.trim()) throw new Error("Issue title cannot be empty");
	const now = new Date().toISOString();
	const issue: CommunityIssue = { id: `issue-${randomUUID()}`, title: input.title.trim(), description: input.description.trim(), status: "open", createdBy: input.createdBy ?? "main", createdAt: now, updatedAt: now, acceptanceCriteria: input.acceptanceCriteria ?? [], comments: [], claims: [] };
	return update(cwd, store => { store.issues.push(issue); return issue; });
}
export function commentOnIssue(cwd: string, id: string, author: string, body: string): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); assertMutable(issue); issue.comments.push({ id: `comment-${randomUUID()}`, author, body: body.trim(), createdAt: new Date().toISOString() }); issue.updatedAt = new Date().toISOString(); return issue; }); }
export function claimIssue(cwd: string, id: string, agent: string, scope: string): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); assertMutable(issue); if (issue.claims.some(claim => claim.status === "active" && claim.scope === scope)) throw new Error(`Scope already claimed: ${scope}`); issue.claims.push({ id: `claim-${randomUUID()}`, agent, scope, status: "active", createdAt: new Date().toISOString() }); issue.status = "executing"; issue.updatedAt = new Date().toISOString(); return issue; }); }
export function submitClaim(cwd: string, id: string, claimId: string): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); assertMutable(issue); const claim = issue.claims.find(item => item.id === claimId); if (!claim) throw new Error(`Claim not found: ${claimId}`); claim.status = "submitted"; issue.status = "reviewing"; issue.updatedAt = new Date().toISOString(); return issue; }); }
export function resolveIssue(cwd: string, id: string): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); assertMutable(issue); if (issue.claims.some(claim => claim.status === "active")) throw new Error("Issue has active claims"); issue.status = "resolved"; issue.updatedAt = new Date().toISOString(); return issue; }); }
export function formatIssue(issue: CommunityIssue): string { return [`${issue.id} · ${issue.status} · ${issue.title}`, issue.description, `claims ${issue.claims.length} · comments ${issue.comments.length}`, ...issue.claims.map(claim => `  ${claim.id} · ${claim.status} ${claim.agent} → ${claim.scope}`)].filter(Boolean).join("\n"); }
