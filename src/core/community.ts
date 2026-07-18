import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
function read(cwd: string): IssueStore { const path = pathFor(cwd); if (!existsSync(path)) return { issues: [] }; try { const value = JSON.parse(readFileSync(path, "utf-8")); return { issues: Array.isArray(value.issues) ? value.issues : [] }; } catch { return { issues: [] }; } }
function save(cwd: string, store: IssueStore): void { mkdirSync(join(cwd, ".agentflux"), { recursive: true }); writeFileSync(pathFor(cwd), JSON.stringify(store, null, 2)); }

export function listIssues(cwd: string): CommunityIssue[] { return read(cwd).issues; }
export function getIssue(cwd: string, id: string): CommunityIssue | undefined { return read(cwd).issues.find(issue => issue.id === id); }
export function createIssue(cwd: string, input: { title: string; description: string; createdBy?: string; acceptanceCriteria?: string[] }): CommunityIssue {
	if (!input.title.trim()) throw new Error("Issue title cannot be empty");
	const store = read(cwd); const now = new Date().toISOString();
	const issue: CommunityIssue = { id: `issue-${randomUUID()}`, title: input.title.trim(), description: input.description.trim(), status: "open", createdBy: input.createdBy ?? "main", createdAt: now, updatedAt: now, acceptanceCriteria: input.acceptanceCriteria ?? [], comments: [], claims: [] };
	store.issues.push(issue); save(cwd, store); return issue;
}
export function commentOnIssue(cwd: string, id: string, author: string, body: string): CommunityIssue { const store = read(cwd); const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); issue.comments.push({ id: `comment-${randomUUID()}`, author, body: body.trim(), createdAt: new Date().toISOString() }); issue.updatedAt = new Date().toISOString(); save(cwd, store); return issue; }
export function claimIssue(cwd: string, id: string, agent: string, scope: string): CommunityIssue { const store = read(cwd); const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); if (issue.claims.some(claim => claim.status === "active" && claim.scope === scope)) throw new Error(`Scope already claimed: ${scope}`); issue.claims.push({ id: `claim-${randomUUID()}`, agent, scope, status: "active", createdAt: new Date().toISOString() }); issue.status = "executing"; issue.updatedAt = new Date().toISOString(); save(cwd, store); return issue; }
export function submitClaim(cwd: string, id: string, claimId: string): CommunityIssue { const store = read(cwd); const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); const claim = issue.claims.find(item => item.id === claimId); if (!claim) throw new Error(`Claim not found: ${claimId}`); claim.status = "submitted"; issue.status = "reviewing"; issue.updatedAt = new Date().toISOString(); save(cwd, store); return issue; }
export function resolveIssue(cwd: string, id: string): CommunityIssue { const store = read(cwd); const issue = store.issues.find(item => item.id === id); if (!issue) throw new Error(`Issue not found: ${id}`); if (issue.claims.some(claim => claim.status === "active")) throw new Error("Issue has active claims"); issue.status = "resolved"; issue.updatedAt = new Date().toISOString(); save(cwd, store); return issue; }
export function formatIssue(issue: CommunityIssue): string { return [`${issue.id} · ${issue.status} · ${issue.title}`, issue.description, `claims ${issue.claims.length} · comments ${issue.comments.length}`, ...issue.claims.map(claim => `  ${claim.id} · ${claim.status} ${claim.agent} → ${claim.scope}`)].filter(Boolean).join("\n"); }
