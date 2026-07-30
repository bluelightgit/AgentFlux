import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJsonStore, updateJsonStore } from "./json-store";

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
function pathFor(cwd: string): string { return join(cwd, ".agentflux", "issues.json"); }
const createStore = (): IssueStore => ({ issues: [] });
const isStore = (value: unknown): value is IssueStore =>
	!!value && typeof value === "object" && Array.isArray((value as IssueStore).issues);
function read(cwd: string): IssueStore { return readJsonStore(pathFor(cwd), createStore, isStore); }
function update<R>(cwd: string, action: (store: IssueStore) => R): R {
	return updateJsonStore(pathFor(cwd), createStore, isStore, action);
}

export function listIssues(cwd: string): CommunityIssue[] { return read(cwd).issues; }
export function getIssue(cwd: string, id: string): CommunityIssue | undefined { return read(cwd).issues.find(issue => issue.id === id); }
export function createIssue(cwd: string, input: { title: string; description: string; createdBy?: string; acceptanceCriteria?: string[] }): CommunityIssue {
	if (!input.title.trim()) throw new Error("Issue title cannot be empty");
	const now = new Date().toISOString();
	const issue: CommunityIssue = { id: `issue-${randomUUID()}`, title: input.title.trim(), description: input.description.trim(), status: "open", createdBy: input.createdBy ?? "main", createdAt: now, updatedAt: now, acceptanceCriteria: input.acceptanceCriteria ?? [], comments: [], claims: [] };
	return update(cwd, store => { store.issues.push(issue); return issue; });
}
export function commentOnIssue(cwd: string, id: string, author: string, body: string): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); issue.comments.push({ id: `comment-${randomUUID()}`, author, body: body.trim(), createdAt: new Date().toISOString() }); issue.updatedAt = new Date().toISOString(); return issue; }); }
export function claimIssue(cwd: string, id: string, agent: string, scope: string): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); if (issue.claims.some(claim => claim.status === "active" && claim.scope === scope)) throw new Error(`Scope already claimed: ${scope}`); issue.claims.push({ id: `claim-${randomUUID()}`, agent, scope, status: "active", createdAt: new Date().toISOString() }); issue.status = "executing"; issue.updatedAt = new Date().toISOString(); return issue; }); }
export function submitClaim(cwd: string, id: string, claimId: string): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); const claim = issue.claims.find(item => item.id === claimId); if (!claim) throw new Error(`Claim not found: ${claimId}`); claim.status = "submitted"; issue.status = "reviewing"; issue.updatedAt = new Date().toISOString(); return issue; }); }
export function resolveIssue(cwd: string, id: string): CommunityIssue { return update(cwd, store => { const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); if (issue.claims.some(claim => claim.status === "active")) throw new Error("Issue has active claims"); issue.status = "resolved"; issue.updatedAt = new Date().toISOString(); return issue; }); }
export function formatIssue(issue: CommunityIssue): string { return [`${issue.id} · ${issue.status} · ${issue.title}`, issue.description, `claims ${issue.claims.length} · comments ${issue.comments.length}`, ...issue.claims.map(claim => `  ${claim.id} · ${claim.status} ${claim.agent} → ${claim.scope}`)].filter(Boolean).join("\n"); }
