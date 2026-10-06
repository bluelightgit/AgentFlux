/**
 * Pi 原生 Agent session 分支适配层。
 *
 * 这里故意只通过 Pi 导出的 SessionManager 读取/创建 session：
 * - 解析 key 时只读并严格验证 JSONL，不用自行拼接 JSONL；
 * - 创建分支统一调用 SessionManager.forkFrom()，由 Pi 负责新 ID、文件和 parentSession；
 * - 找不到可证明的源文件时 fail-closed，绝不把 key 当成 session 文件。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../core/types";

export interface SessionHeaderIdentity {
	type: "session";
	id: string;
	parentSession?: string;
}

export interface NativeAgentSessionFork {
	/** The immutable source file used by Pi. */
	sourceFile: string;
	sourceSessionId: string;
	/** The source leaf entry copied by Pi (when the source has entries). */
	sourceLeafId: string | null;
	targetFile: string;
	targetSessionId: string;
	parentSession: string;
}

export interface NativeAgentSessionForkOptions {
	/** Deterministic role/capability target ID; omitted for the initial Agent fork. */
	targetSessionId?: string;
}

/** Same normalization used by the runner's --session-id path. */
export function normalizePersistentSessionId(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
}

/**
 * Native fork targets are role/capability-specific. Keeping this ID
 * deterministic lets the runner reopen the same branch without adding a
 * second registry or storing a mtime-based guess.
 */
export function capabilitySessionId(baseSessionId: string, capabilityGeneration: string): string {
	const suffix = `-cap-${capabilityGeneration}`;
	const base = normalizePersistentSessionId(baseSessionId);
	if (!base) throw new Error("Cannot derive capability session ID from an empty base session ID");
	const prefixLength = Math.max(1, 120 - suffix.length);
	return `${base.slice(0, prefixLength)}${suffix}`;
}

/**
 * Parse and strictly validate a Pi JSONL session. Pi's loader may skip bad
 * lines for recovery, but an Agent fork must not silently omit source context.
 */
function readSessionHeader(filePath: string): SessionHeaderIdentity | undefined {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	let header: SessionHeaderIdentity | undefined;
	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let entry: any;
		try { entry = JSON.parse(line); } catch { return undefined; }
		if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.type !== "string") return undefined;
		if (!header) {
			if (entry.type !== "session" || typeof entry.id !== "string" || !entry.id.trim()) return undefined;
			header = {
				type: "session",
				id: entry.id,
				parentSession: typeof entry.parentSession === "string" ? entry.parentSession : undefined,
			};
		}
	}
	return header;
}

interface SessionFileCandidate {
	path: string;
	header: SessionHeaderIdentity;
}

function sessionIdFromFileName(name: string): string | undefined {
	if (!name.endsWith(".jsonl")) return undefined;
	const stem = name.slice(0, -".jsonl".length);
	const separator = stem.indexOf("_");
	return separator >= 0 ? stem.slice(separator + 1) : undefined;
}

function keyMatchesSessionId(sessionKey: string, physicalId: string): boolean {
	const normalized = normalizePersistentSessionId(sessionKey);
	return physicalId === normalized || physicalId.startsWith(`${normalized}-cap-`);
}

/** A malformed file with a matching physical key is evidence, not a candidate. */
function assertNoMalformedKeyFiles(sessionDir: string, sessionKey: string): void {
	try {
		for (const name of readdirSync(sessionDir).filter(item => item.endsWith(".jsonl"))) {
			const physicalId = sessionIdFromFileName(name);
			if (!physicalId || !keyMatchesSessionId(sessionKey, physicalId)) continue;
			const path = join(sessionDir, name);
			const header = readSessionHeader(path);
			if (!header || header.id !== physicalId) {
				throw new Error(`Invalid or ambiguous Pi session file for key "${sessionKey}": ${path}`);
			}
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Invalid or ambiguous")) throw error;
		// Missing session directory means no physical proof, not a storage error.
	}
}

function listSessionFiles(sessionDir: string): SessionFileCandidate[] {
	try {
		return readdirSync(sessionDir)
			.filter(name => name.endsWith(".jsonl"))
			.map(name => {
				const path = join(sessionDir, name);
				try {
					if (!statSync(path).isFile()) return undefined;
					const header = readSessionHeader(path);
					if (!header) return undefined;
					const physicalId = sessionIdFromFileName(name);
					if (physicalId && physicalId !== header.id) return undefined;
					return { path, header };
				} catch {
					return undefined;
				}
			})
			.filter((item): item is SessionFileCandidate => item !== undefined);
	} catch {
		return [];
	}
}

/** Resolve an exact Pi session ID to its physical file without mutating it. */
export function resolveSessionFileById(sessionDir: string, sessionId: string | undefined): string | undefined {
	if (!sessionId) return undefined;
	assertNoMalformedKeyFiles(sessionDir, sessionId);
	const matches = listSessionFiles(sessionDir).filter(item => item.header.id === sessionId);
	if (matches.length > 1) {
		throw new Error(`Ambiguous Pi session id "${sessionId}" in ${resolve(sessionDir)}`);
	}
	return matches[0]?.path;
}

/**
 * Resolve a runner key to its actual Pi file. Capability siblings are
 * intentionally not ordered by mtime: more than one physical candidate is
 * ambiguous unless Core supplies the exact lastSessionId.
 */
export function resolveSessionFileForKey(sessionDir: string, sessionKey: string | undefined): string | undefined {
	if (!sessionKey) return undefined;
	assertNoMalformedKeyFiles(sessionDir, sessionKey);
	const normalized = normalizePersistentSessionId(sessionKey);
	const files = listSessionFiles(sessionDir);
	const exact = files.filter(item => item.header.id === normalized);
	if (exact.length > 1) {
		throw new Error(`Ambiguous Pi session key "${sessionKey}" in ${resolve(sessionDir)}`);
	}
	if (exact.length === 1) return exact[0].path;
	const capabilityMatches = files.filter(item => item.header.id.startsWith(`${normalized}-cap-`));
	if (capabilityMatches.length > 1) {
		throw new Error(`Ambiguous capability sessions for key "${sessionKey}" in ${resolve(sessionDir)}`);
	}
	return capabilityMatches[0]?.path;
}

/** Resolve an Agent's physical session, never falling back past an explicit lastSessionId. */
export function resolveAgentSessionFileForRecord(sessionDir: string, record: Pick<AgentRecord, "sessionId" | "lastSessionId">): string | undefined {
	if (record.lastSessionId) return resolveSessionFileForKey(sessionDir, record.lastSessionId);
	return resolveSessionFileForKey(sessionDir, record.sessionId);
}

/** Check an explicit file against every known Agent key without choosing a sibling by mtime. */
export function sessionFileMatchesAgentRecord(filePath: string, record: Pick<AgentRecord, "sessionId" | "lastSessionId">): boolean {
	const header = readSessionHeader(resolve(filePath));
	if (!header) return false;
	return [record.sessionId, record.lastSessionId]
		.filter((key): key is string => !!key)
		.some(key => keyMatchesSessionId(key, header.id));
}

/** Resolve an explicit path from the caller; IDs are intentionally not guessed here. */
export function resolveExplicitSessionFile(cwd: string, input: string): string {
	const candidate = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
	if (!existsSync(candidate)) throw new Error(`Fork source session file does not exist: ${candidate}`);
	try {
		if (!statSync(candidate).isFile()) throw new Error(`Fork source is not a file: ${candidate}`);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Fork source")) throw error;
		throw new Error(`Fork source session file is not readable: ${candidate}`);
	}
	if (!readSessionHeader(candidate)) throw new Error(`Fork source is not a valid Pi session: ${candidate}`);
	return candidate;
}

function sourceHash(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Use Pi's native full-session fork. The source is checked before and after
 * the SDK call so a concurrent writer cannot be mistaken for a stable branch.
 */
export function forkAgentSession(sourcePath: string, targetCwd: string, targetSessionDir: string, options: NativeAgentSessionForkOptions = {}): NativeAgentSessionFork {
	const sourceFile = resolve(sourcePath);
	const sourceHeader = readSessionHeader(sourceFile);
	if (!sourceHeader) throw new Error(`Fork source is not a valid Pi session: ${sourceFile}`);
	const beforeHash = sourceHash(sourceFile);
	let target: SessionManager | undefined;
	try {
		target = SessionManager.forkFrom(sourceFile, targetCwd, targetSessionDir, options.targetSessionId ? { id: options.targetSessionId } : undefined);
		const afterHash = sourceHash(sourceFile);
		if (beforeHash !== afterHash) {
			const targetFile = target.getSessionFile();
			if (targetFile) {
				try { rmSync(targetFile, { force: true }); } catch { /* preserve the fail-closed error */ }
			}
			throw new Error(`Fork source changed while creating native branch: ${sourceFile}`);
		}
		const targetFile = target.getSessionFile();
		const targetHeader = target.getHeader();
		const targetSessionId = target.getSessionId();
		if (!targetFile || !targetHeader || targetHeader.parentSession !== sourceFile || !targetSessionId || targetSessionId === sourceHeader.id
			|| (options.targetSessionId !== undefined && targetSessionId !== options.targetSessionId)) {
			if (targetFile) {
				try { rmSync(targetFile, { force: true }); } catch { /* preserve the fail-closed error */ }
			}
			throw new Error(`Pi native fork did not produce an independent session for ${sourceFile}`);
		}
		return {
			sourceFile,
			sourceSessionId: sourceHeader.id,
			sourceLeafId: target.getLeafId(),
			targetFile,
			targetSessionId,
			parentSession: targetHeader.parentSession,
		};
	} catch (error) {
		if (error instanceof Error && error.message.includes("native branch")) throw error;
		throw new Error(`Pi native session fork failed for ${sourceFile}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Ensure a deterministic role/capability branch rooted at the Agent fork target. */
export function ensureCapabilityForkSession(
	sourceFile: string,
	targetCwd: string,
	targetSessionDir: string,
	baseSessionId: string,
	capabilityGeneration: string,
): NativeAgentSessionFork {
	const targetSessionId = capabilitySessionId(baseSessionId, capabilityGeneration);
	const existing = resolveSessionFileById(targetSessionDir, targetSessionId);
	if (existing) {
		const sourceHeader = readSessionHeader(resolve(sourceFile));
		const targetHeader = readSessionHeader(existing);
		if (!sourceHeader || !targetHeader || targetHeader.parentSession !== resolve(sourceFile)) {
			throw new Error(`Native capability branch parent mismatch for ${targetSessionId}`);
		}
		return {
			sourceFile: resolve(sourceFile),
			sourceSessionId: sourceHeader.id,
			sourceLeafId: null,
			targetFile: existing,
			targetSessionId,
			parentSession: targetHeader.parentSession,
		};
	}
	return forkAgentSession(sourceFile, targetCwd, targetSessionDir, { targetSessionId });
}
