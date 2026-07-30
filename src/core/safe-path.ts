import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * IDs used as path segments must remain opaque. Keeping this stricter than a
 * general display name makes every filesystem use safe on Windows and POSIX.
 */
export function assertSafeOpaqueId(value: string, label = "id"): string {
	const normalized = value.trim();
	if (!OPAQUE_ID.test(normalized) || WINDOWS_RESERVED_NAME.test(normalized)) {
		throw new Error(`${label} must be a 1-128 character opaque id using only letters, numbers, '_' or '-'`);
	}
	return normalized;
}

export function assertSafePathSegment(value: string, label = "path segment"): string {
	const normalized = value.trim();
	if (!SAFE_PATH_SEGMENT.test(normalized) || normalized.endsWith(".") || WINDOWS_RESERVED_NAME.test(normalized)) {
		throw new Error(`${label} must be a safe 1-128 character path segment`);
	}
	return normalized;
}

/**
 * Resolve a path below an existing root and reject both lexical traversal and
 * an existing symlink ancestor that escapes the root.
 */
export function resolvePathInsideExistingRoot(root: string, ...parts: string[]): string {
	const resolvedRoot = resolve(root);
	if (!existsSync(resolvedRoot)) throw new Error(`safe path root does not exist: ${resolvedRoot}`);
	const candidate = resolve(resolvedRoot, ...parts);
	if (!isInside(resolvedRoot, candidate)) throw new Error(`path escapes root: ${candidate}`);

	const realRoot = realpathSync(resolvedRoot);
	let existingAncestor = candidate;
	while (!existsSync(existingAncestor)) {
		const parent = dirname(existingAncestor);
		if (parent === existingAncestor) break;
		existingAncestor = parent;
	}
	if (existsSync(existingAncestor)) {
		const realAncestor = realpathSync(existingAncestor);
		if (!isInside(realRoot, realAncestor)) {
			throw new Error(`path escapes root through symlink: ${candidate}`);
		}
	}
	return candidate;
}
