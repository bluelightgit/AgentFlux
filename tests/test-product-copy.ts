import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { productCopyViolations, hasProductCopyViolation } from "./helpers/product-copy";
import { formatIssue, type CommunityIssue } from "../src/core/community";
import { formatCacheImpactWarning, assessCacheImpact } from "../src/core/cache-impact";
import { getFluxArgumentCompletions, FLUX_HELP } from "../src/extension/commands";
import { formatGroups, formatAgents } from "../src/core/shared-board";

const root = resolve(import.meta.dirname, "..");
assert.equal(productCopyViolations("example.ts", '// 中文开发注释\nconst rx = /继续/; const text = `Task: ${userText}`;').length, 0);
assert.equal(productCopyViolations("example.ts", 'const text = "\\u4e2d";').length, 1, "escaped product text must also be checked");
assert.equal(productCopyViolations("example.ts", 'const text = `State: ${state} 完成`;').length, 1);
for (const icon of ["😀", "⚠", "✓", "👩‍💻", "🇨🇳", "1️⃣"]) assert.ok(hasProductCopyViolation(icon));
assert.equal(hasProductCopyViolation("[PASS] 1 * # -> | ─ ↑↓"), false);
const files: string[] = [];
function walk(dir: string): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path);
		else if (/\.[cm]?[jt]sx?$/.test(path)) files.push(path);
	}
}
walk(join(root, "src"));
const violations = files.flatMap(file => productCopyViolations(file, readFileSync(file, "utf8")));
assert.deepEqual(violations, [], `Product-owned strings must be English and icon-free:\n${JSON.stringify(violations, null, 2)}`);
const models = JSON.parse(readFileSync(join(root, ".agentflux/models.json"), "utf8"));
for (const [name, role] of Object.entries(models.roles ?? {}) as Array<[string, any]>) {
	for (const key of ["description", "systemPrompt"]) if (role[key]) assert.equal(hasProductCopyViolation(role[key]), false, `${name}.${key}`);
}
const localRoles = join(root, ".agentflux/agents");
if (existsSync(localRoles)) for (const name of readdirSync(localRoles).filter(name => name.endsWith(".md"))) {
	assert.equal(hasProductCopyViolation(readFileSync(join(localRoles, name), "utf8")), false, `Local role override: ${name}`);
}
const issue = { id: "issue-copy", title: "Review", description: "Check behavior", status: "open", claims: [], comments: [], proposals: [], rounds: 0, costUsd: 0 } as unknown as CommunityIssue;
for (const text of [FLUX_HELP, JSON.stringify(getFluxArgumentCompletions("issue r")), formatIssue(issue), formatCacheImpactWarning(assessCacheImpact("tool_schema"))!,
	formatGroups([{ id: "all", name: "All Agents", type: "all", members: ["reader"], description: "Public" }] as any),
	formatAgents([{ name: "reader", role: "reviewer", status: "running" }] as any)]) {
	assert.equal(hasProductCopyViolation(text), false, text);
}
const userText = "用户正文保持原样 😀";
assert.ok(formatIssue({ ...issue, title: userText }).includes(userText), "presentation must not strip or translate user data");
console.log(`Product copy checks passed (${files.length} source files, role assets, formatters, user data preserved)`);
