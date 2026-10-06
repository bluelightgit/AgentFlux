import { randomUUID } from "node:crypto";
import { registerActiveContext, releaseActiveContext, releaseActiveContexts } from "./active-context";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonStore, withJsonStoreLock, writeJsonFileAtomic } from "./json-store";
import { updateReferenceStore as updateJsonStore, withAgentReferenceFence } from "./agent-reference-fence";
import { assertAgentReference } from "./agent-reference-target";

export type IssueStatus = "open" | "triage" | "forming" | "executing" | "reviewing" | "resolved" | "blocked";
export interface IssueComment { id: string; author: string; body: string; createdAt: string; }
export interface IssueProposal { id: string; title: string; body: string; createdBy: string; createdAt: string; supporters: string[]; opposers: string[]; }
export interface IssueClaim { id: string; agent: string; agentId?: string; scope: string; status: "active" | "submitted" | "reviewed"; createdAt: string; proposalIds: string[]; plan: string; /** 与 active-context.json 中该 Claim 的具体 lease 对应。 */ leaseId?: string; }
export type IssueEventType =
	| "created" | "commented" | "claimed" | "submitted"
	| "reviewed" | "reworked" | "resolved" | "blocked" | "unblocked"
	| "proposed" | "supported" | "opposed";
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
	proposals: IssueProposal[];
	timeline: IssueEvent[];
	/** 认领次数累计（跨认领计数，门禁“最大轮次”用；旧数据无此字段，读取时按 0 容错）。 */
	rounds?: number;
	/** 累计执行成本（submit 时可选传入累加，门禁“预算超支”用）。 */
	costUsd?: number;
	/** 连续无进展退回次数（feedback 为空或与上一次相同则 +1，否则重置；pass 后重置）。 */
	stallStreak?: number;
	/** 上一次退回反馈（用于判断“无进展”）。 */
	lastReworkFeedback?: string;
	/** 决策记录：解决理由（可选，写入时间线 resolved 事件）。 */
	resolvedReason?: string;
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
		proposals: [],
		timeline: [],
	}));
}

/** 旧数据归一化：缺 proposals/plan/proposalIds 的 issue 与 claim 补齐默认值（内存中补齐，随下次写回持久化）。 */
function normalizeIssue(issue: CommunityIssue): CommunityIssue {
	if (!Array.isArray(issue.proposals)) issue.proposals = [];
	issue.claims = (issue.claims ?? []).map(claim => ({ ...claim, proposalIds: claim.proposalIds ?? [], plan: claim.plan ?? "" }));
	return issue;
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
		return withAgentReferenceFence(() => withJsonStoreLock(path, () => {
			// 首次读之后可能已有另一个 writer 迁移或追加；持锁重新读，绝不回写旧快照。
			const latest = readJsonStore<IssueStore | LegacyIssueRecord[]>(path, createStore,
				(value): value is IssueStore | LegacyIssueRecord[] => isStore(value) || isLegacyIssueArray(value));
			if (!isLegacyIssueArray(latest)) return { issues: latest.issues.map(normalizeIssue) };
			const store: IssueStore = { issues: migrateLegacyIssues(latest) };
			writeJsonFileAtomic(path, store);
			return store;
		}));
	}
	if (!isStore(raw)) throw new Error(`JSON store schema is invalid and was not overwritten: ${path}`);
	raw.issues = raw.issues.map(normalizeIssue);
	return raw;
}
function update<R>(cwd: string, action: (store: IssueStore) => R): R {
	// 旧格式文件先经 read() 迁移并写回，updateJsonStore 才能通过 schema 校验。
	read(cwd);
	return updateJsonStore(pathFor(cwd), createStore, isStore, store => {
		store.issues = store.issues.map(normalizeIssue);
		return action(store);
	});
}

/** 终态守卫: resolved 后的 issue 不可再变更 (与 Task Registry 的不可变终态一致)。 */
function assertMutable(issue: CommunityIssue): void {
	if (issue.status === "resolved") throw new Error(`Issue is already resolved and immutable: ${issue.id}`);
}

// ─── 停止条件门禁（docs/33 7.3：核心模块检查，任何入口统一生效） ───────────────

let stallThreshold = 3;
let maxCostPerTask = 2;
let maxRounds = 5;

/** 由入口层在初始化时设置门禁参数（与 FluxConfig 对齐；不设置则用默认值）。 */
export function setCommunityLimits(limits: { stallThreshold?: number; maxCostPerTask?: number; maxRounds?: number } = {}): void {
	if (limits.stallThreshold !== undefined) {
		if (!Number.isInteger(limits.stallThreshold) || limits.stallThreshold < 1) throw new Error("community stallThreshold must be a positive integer");
		stallThreshold = limits.stallThreshold;
	}
	if (limits.maxCostPerTask !== undefined) {
		if (!Number.isFinite(limits.maxCostPerTask) || limits.maxCostPerTask <= 0) throw new Error("community maxCostPerTask must be > 0");
		maxCostPerTask = limits.maxCostPerTask;
	}
	if (limits.maxRounds !== undefined) {
		if (!Number.isInteger(limits.maxRounds) || limits.maxRounds < 1) throw new Error("community maxRounds must be a positive integer");
		maxRounds = limits.maxRounds;
	}
}

/** 最大轮次门禁：认领会使轮次 +1，超过上限拒绝（含当前次数与上限）。 */
function assertRoundWithinLimits(issue: CommunityIssue): void {
	const next = (issue.rounds ?? 0) + 1;
	if (next > maxRounds) {
		throw new Error(`Community stall guard: round limit exceeded (current ${issue.rounds ?? 0}/${maxRounds}); claim rejected. Request human review before changing budget.max_iterations or terminating the Issue`);
	}
}

/** 预算门禁：提交认领时累加执行成本，超过每任务成本上限拒绝。 */
function assertCostWithinLimits(issue: CommunityIssue, costUsd: number): void {
	const next = (issue.costUsd ?? 0) + costUsd;
	if (next > maxCostPerTask) {
		throw new Error(`Community stall guard: budget exceeded (accumulated $${(issue.costUsd ?? 0).toFixed(4)} + submission $${costUsd.toFixed(4)} > $${maxCostPerTask}); submission rejected. Request human review before changing budget.max_cost_per_task or terminating the Issue`);
	}
}

/** 无进展门禁：连续退回且反馈为空或与上一次相同，达到阈值后拒绝。 */
function assertNoStall(issue: CommunityIssue): void {
	if ((issue.stallStreak ?? 0) >= stallThreshold) {
		throw new Error(`Community stall guard: ${issue.stallStreak} consecutive rework decisions without new feedback (threshold ${stallThreshold}); no progress. Request human review or use /flux issue resolve`);
	}
}

/** 评审退回分支：计算本次退回后的连续无进展次数，若将触发阈值则拒绝退回。 */
function nextStallStreak(issue: CommunityIssue, feedback: string): number {
	const fb = feedback.trim();
	if (fb === "" || fb === (issue.lastReworkFeedback ?? "")) return (issue.stallStreak ?? 0) + 1;
	return 1;
}

function appendEvent(issue: CommunityIssue, type: IssueEventType, actor: string, detail: string): void {
	if (!issue.timeline) issue.timeline = [];
	issue.timeline.push({ id: `evt-${randomUUID()}`, type, actor, detail, createdAt: new Date().toISOString() });
}

/** 非终态 issue 的确定性下一步（状态机推导，不依赖 LLM）。 */
export function nextActions(issue: CommunityIssue): string[] {
	if (issue.status === "resolved") return [];
	if ((issue.stallStreak ?? 0) >= stallThreshold) {
		return [`Stop condition reached (${issue.stallStreak} consecutive rework decisions without new feedback, threshold ${stallThreshold}). Request human review: resolve with /flux issue resolve <id> [reason], or adjust budget/community_stall_threshold before continuing`];
	}
	if (issue.status === "reviewing") {
		const pending = issue.claims.filter(claim => claim.status === "submitted");
		const reviewedAll = issue.claims.length > 0 && issue.claims.every(claim => claim.status === "reviewed");
		if (pending.length > 0) return ["review claim: flux_issue review <id> <claimId> pass|rework [feedback]"];
		if (reviewedAll) return ["resolve issue: flux_issue resolve <id>"];
		return [];
	}
	if (issue.status === "executing" || issue.status === "open" || issue.status === "forming" || issue.status === "blocked") {
		const active = issue.claims.filter(claim => claim.status === "active");
		const steps: string[] = [];
		if (issue.status === "open" || issue.status === "forming") steps.push("propose a plan: flux_issue propose <id> <title> <body>");
		if (active.length > 0) steps.push("submit claim: flux_issue submit <id> <claimId>");
		else steps.push("claim scope: flux_issue claim <id> <agent> <scope> [--plan <text>]");
		return steps;
	}
	return [];
}

export function listIssues(cwd: string): CommunityIssue[] { return read(cwd).issues; }
export function getIssue(cwd: string, id: string): CommunityIssue | undefined { return read(cwd).issues.find(issue => issue.id === id); }

/** 终态对象清理所有历史/当前 Claim leases；单个 Claim 的生命周期使用其 leaseId。 */
function releaseIssueClaimLeases(cwd: string, issue: CommunityIssue): void {
	const leaseIds = new Set((issue.claims ?? []).map(claim => claim.leaseId).filter((leaseId): leaseId is string => !!leaseId));
	for (const leaseId of leaseIds) releaseActiveContext(cwd, leaseId);
	// 兼容没有 leaseId 的旧 claim，并清理旧版本使用 issue:<id> 作为 name 的条目。
	const prefix = `issue:${issue.id}`;
	releaseActiveContexts(cwd, entry => entry.context === "community"
		&& (entry.name === prefix || entry.name.startsWith(`${prefix}:`)));
}

function releaseClaimLease(cwd: string, issueId: string, claim: IssueClaim): void {
	if (claim.leaseId) {
		releaseActiveContext(cwd, claim.leaseId);
		return;
	}
	const legacyName = `issue:${issueId}`;
	releaseActiveContexts(cwd, entry => entry.context === "community" && entry.name === legacyName);
}

export function createIssue(cwd: string, input: { title: string; description: string; createdBy?: string; acceptanceCriteria?: string[] }): CommunityIssue {
	if (!input.title.trim()) throw new Error("Issue title cannot be empty");
	const now = new Date().toISOString();
	const issue: CommunityIssue = { id: `issue-${randomUUID()}`, title: input.title.trim(), description: input.description.trim(), status: "open", createdBy: input.createdBy ?? "main", createdAt: now, updatedAt: now, acceptanceCriteria: input.acceptanceCriteria ?? [], comments: [], claims: [], proposals: [], timeline: [], rounds: 0, costUsd: 0, stallStreak: 0, lastReworkFeedback: "" };
	return update(cwd, store => { store.issues.push(issue); appendEvent(issue, "created", issue.createdBy, input.title.trim()); return issue; });
}
export function commentOnIssue(cwd: string, id: string, author: string, body: string): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); assertMutable(issue); issue.comments.push({ id: `comment-${randomUUID()}`, author, body: body.trim(), createdAt: new Date().toISOString() }); issue.updatedAt = new Date().toISOString(); appendEvent(issue, "commented", author, body.trim().slice(0, 120)); return issue; }); }
/** 提出提案（轻量实体，无自身状态机；支持/反对只是简单列表）。 */
export function proposeIssue(cwd: string, id: string, input: { title: string; body: string; createdBy?: string }): CommunityIssue {
	if (!input.title.trim()) throw new Error("Proposal title cannot be empty");
	return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); assertMutable(issue); if (!Array.isArray(issue.proposals)) issue.proposals = []; const proposal: IssueProposal = { id: `proposal-${randomUUID()}`, title: input.title.trim(), body: input.body.trim(), createdBy: input.createdBy ?? "main", createdAt: new Date().toISOString(), supporters: [], opposers: [] }; issue.proposals.push(proposal); issue.updatedAt = new Date().toISOString(); appendEvent(issue, "proposed", proposal.createdBy, `${proposal.id} · ${proposal.title}`); return issue; }); }
/** 支持提案：同一人不能既支持又反对；重复支持报错。 */
export function supportProposal(cwd: string, issueId: string, proposalId: string, actor: string): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === issueId); if (!issue) throw new Error(`Issue not found: ${issueId}`); assertMutable(issue); const proposal = (issue.proposals ?? []).find(item => item.id === proposalId); if (!proposal) throw new Error(`Proposal not found: ${proposalId}`); if (proposal.supporters.includes(actor)) throw new Error(`Already supported by ${actor}: ${proposalId}`); if (proposal.opposers.includes(actor)) throw new Error(`${actor} already opposes this proposal: ${proposalId}`); proposal.supporters.push(actor); issue.updatedAt = new Date().toISOString(); appendEvent(issue, "supported", actor, `${proposalId} · ${proposal.title}`); return issue; }); }
/** 反对提案：同一人不能既支持又反对；重复反对报错。 */
export function opposeProposal(cwd: string, issueId: string, proposalId: string, actor: string): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === issueId); if (!issue) throw new Error(`Issue not found: ${issueId}`); assertMutable(issue); const proposal = (issue.proposals ?? []).find(item => item.id === proposalId); if (!proposal) throw new Error(`Proposal not found: ${proposalId}`); if (proposal.opposers.includes(actor)) throw new Error(`Already opposed by ${actor}: ${proposalId}`); if (proposal.supporters.includes(actor)) throw new Error(`${actor} already supports this proposal: ${proposalId}`); proposal.opposers.push(actor); issue.updatedAt = new Date().toISOString(); appendEvent(issue, "opposed", actor, `${proposalId} · ${proposal.title}`); return issue; }); }
export function claimIssue(cwd: string, id: string, agent: string, scope: string, opts: { proposalIds?: string[]; plan?: string; agentId?: string; ownerSessionId?: string } = {}): CommunityIssue {
	return withAgentReferenceFence(() => claimIssueInternal(cwd, id, agent, scope, opts));
}

function claimIssueInternal(cwd: string, id: string, agent: string, scope: string, opts: NonNullable<Parameters<typeof claimIssue>[4]>): CommunityIssue {
	const explicitId = opts.agentId !== undefined ? opts.agentId : /^agent-[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(agent) ? agent : undefined;
	if (explicitId !== undefined) {
		const target = assertAgentReference(cwd, explicitId, opts.ownerSessionId);
		opts = { ...opts, agentId: target.id }; agent = target.name;
	}
	// F 阻止并发 Issue writer；业务拒绝在创建任何 lease 前完成。
	const before = getIssue(cwd, id);
	if (!before) throw new Error(`Issue not found: ${id}`);
	assertMutable(before);
	if (before.claims.some(claim => claim.status === "active" && claim.scope === scope)) throw new Error(`Scope already claimed: ${scope}`);
	assertRoundWithinLimits(before); assertNoStall(before);
	for (const proposalId of opts.proposalIds ?? []) {
		if (!(before.proposals ?? []).some(proposal => proposal.id === proposalId)) throw new Error(`Proposal not found: ${proposalId}`);
	}
	const claimId = `claim-${randomUUID()}`;
	const lease = registerActiveContext(cwd, {
		name: `issue:${id}:${claimId}`,
		context: "community",
		scope: claimId,
		task: `claim ${agent} → ${scope}`,
	});
	try {
		return update(cwd, store => {
			const issue = store.issues.find(item => item.id === id);
			if (!issue) throw new Error(`Issue not found: ${id}`);
			assertMutable(issue);
			if (issue.claims.some(claim => claim.status === "active" && claim.scope === scope)) throw new Error(`Scope already claimed: ${scope}`);
			assertRoundWithinLimits(issue);
			assertNoStall(issue);
			for (const pid of opts.proposalIds ?? []) {
				if (!(issue.proposals ?? []).some(proposal => proposal.id === pid)) throw new Error(`Proposal not found: ${pid}`);
			}
			const claim: IssueClaim = {
				id: claimId,
				agent,
				agentId: opts.agentId,
				scope,
				status: "active",
				createdAt: new Date().toISOString(),
				proposalIds: [...(opts.proposalIds ?? [])],
				plan: opts.plan?.trim() ?? "",
				leaseId: lease.leaseId,
			};
			issue.claims.push(claim);
			issue.rounds = (issue.rounds ?? 0) + 1;
			issue.status = "executing";
			issue.updatedAt = new Date().toISOString();
			appendEvent(issue, "claimed", agent, `${claim.id} → ${scope}${claim.proposalIds.length ? ` · proposals: ${claim.proposalIds.join(",")}` : ""}${claim.plan ? ` · plan: ${claim.plan.slice(0, 80)}` : ""}`);
			return issue;
		});
	} catch (error) {
		try { releaseActiveContext(cwd, lease.leaseId); }
		catch (cleanupError) { throw new AggregateError([error, cleanupError], `Claim failed and lease cleanup failed: ${lease.leaseId}`); }
		throw error;
	}
}
export function submitClaim(cwd: string, id: string, claimId: string, plan?: string, costUsd?: number): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); assertMutable(issue); const claim = issue.claims.find(item => item.id === claimId); if (!claim) throw new Error(`Claim not found: ${claimId}`); if (claim.status !== "active") throw new Error(`Claim is not active: ${claimId}`); if (costUsd !== undefined && Number.isFinite(costUsd) && costUsd > 0) assertCostWithinLimits(issue, costUsd); assertNoStall(issue); if (plan !== undefined) claim.plan = plan.trim(); claim.status = "submitted"; issue.status = "reviewing"; issue.costUsd = (issue.costUsd ?? 0) + (costUsd !== undefined && Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0); issue.updatedAt = new Date().toISOString(); appendEvent(issue, "submitted", claim.agent, `${claimId}${claim.plan ? ` · plan: ${claim.plan.slice(0, 120)}` : ""}`); return issue; }); }
export function reviewClaim(cwd: string, id: string, claimId: string, verdict: "pass" | "rework", reviewer: string, feedback = ""): CommunityIssue {
	if (verdict !== "pass" && verdict !== "rework") throw new Error("review requires verdict pass or rework");
	const issue = update(cwd, store => {
		const item = store.issues.find(entry => entry.id === id);
		if (!item) throw new Error(`Issue not found: ${id}`);
		assertMutable(item);
		const claim = item.claims.find(entry => entry.id === claimId);
		if (!claim) throw new Error(`Claim not found: ${claimId}`);
		if (claim.status !== "submitted") throw new Error(`Claim is not in review: ${claimId} (status=${claim.status})`);
		if (verdict === "pass") {
			claim.status = "reviewed";
			item.stallStreak = 0;
			item.lastReworkFeedback = "";
			appendEvent(item, "reviewed", reviewer, `${claimId} ${feedback ? `· ${feedback.slice(0, 120)}` : ""}`.trim());
		} else {
			const streak = nextStallStreak(item, feedback);
			if (streak > stallThreshold) {
				throw new Error(`Community stall guard: this rework would reach ${streak} consecutive decisions without progress (threshold ${stallThreshold}); rejected. Provide new, specific feedback, or approve with pass if the work meets the criteria`);
			}
			claim.status = "active";
			item.status = "executing";
			item.stallStreak = streak;
			item.lastReworkFeedback = feedback.trim();
			appendEvent(item, "reworked", reviewer, `${claimId} ${feedback ? `· ${feedback.slice(0, 120)}` : ""}`.trim());
		}
		item.updatedAt = new Date().toISOString();
		return item;
	});
	if (verdict === "pass") {
		const claim = issue.claims.find(item => item.id === claimId);
		if (claim) releaseClaimLease(cwd, id, claim);
	}
	return issue;
}
/** 删除已结束的 Issue（resolved 或 open 且无 active claim）；有活跃认领的拒绝。 */
export function deleteIssue(cwd: string, id: string): CommunityIssue {
	const issue = update(cwd, store => {
		const index = store.issues.findIndex(item => item.id === id);
		if (index < 0) throw new Error(`Issue not found: ${id}`);
		const item = store.issues[index];
		if (item.claims.some(claim => claim.status === "active" || claim.status === "submitted")
			&& (item.stallStreak ?? 0) < stallThreshold) {
			throw new Error(`Issue has active or submitted claims: ${id}`);
		}
		if ((item.stallStreak ?? 0) < stallThreshold && item.status !== "resolved" && item.status !== "open") {
			throw new Error(`Only resolved or open issues can be deleted (${item.status}): ${id}`);
		}
		store.issues.splice(index, 1);
		return item;
	});
	// 停摆兑底删除也释放认领时注册的 community 空间条目，避免幽灵占用阻塞其他空间
	releaseIssueClaimLeases(cwd, issue);
	return issue;
}

export function resolveIssue(cwd: string, id: string, reason?: string): CommunityIssue {
	const issue = update(cwd, store => {
		const item = store.issues.find(entry => entry.id === id);
		if (!item) throw new Error(`Issue not found: ${id}`);
		assertMutable(item);
		if ((item.stallStreak ?? 0) < stallThreshold && item.claims.some(claim => claim.status === "active" || claim.status === "submitted")) throw new Error("Issue has active or submitted claims");
		item.status = "resolved";
		if (reason?.trim()) item.resolvedReason = reason.trim();
		item.updatedAt = new Date().toISOString();
		appendEvent(item, "resolved", "main", reason?.trim() ? `${id} · ${reason.trim().slice(0, 200)}` : id);
		return item;
	});
	releaseIssueClaimLeases(cwd, issue);
	return issue;
}
export function formatIssue(issue: CommunityIssue): string { const stall = (issue.stallStreak ?? 0) >= stallThreshold;
	return [`${issue.id} · ${issue.status} · ${issue.title}`, issue.description, `rounds ${issue.rounds ?? 0} · cost $${(issue.costUsd ?? 0).toFixed(4)} · claims ${issue.claims.length} · comments ${issue.comments.length} · proposals ${(issue.proposals ?? []).length}`, ...(issue.proposals ?? []).map(proposal => `  ${proposal.id} · ${proposal.title} · by ${proposal.createdBy} · support ${proposal.supporters.length} oppose ${proposal.opposers.length}`), ...issue.claims.map(claim => `  ${claim.id} · ${claim.status} ${claim.agent} → ${claim.scope}${claim.proposalIds?.length ? ` · proposals: ${claim.proposalIds.join(",")}` : ""}${claim.plan ? ` · plan: ${claim.plan.slice(0, 80)}` : ""}`), stall ? `WARNING: Stop condition reached: ${issue.stallStreak} consecutive rework decisions without new feedback (threshold ${stallThreshold}); request human review or resolve` : "", issue.resolvedReason ? `resolved reason: ${issue.resolvedReason}` : "", ...(nextActions(issue).map(action => `next: ${action}`))].filter(Boolean).join("\n"); }
export function formatIssueTimeline(issue: CommunityIssue): string {
	const events = issue.timeline ?? [];
	if (events.length === 0) return "(no timeline)";
	return events.map(event => `  [${event.type}] ${event.actor} · ${event.detail} @ ${event.createdAt}`).join("\n");
}
