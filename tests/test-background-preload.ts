import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { resolve } from "node:path";

const preload = resolve(import.meta.dirname, "../src/agents/background-preload.mjs");
const helper = resolve(import.meta.dirname, "helpers/background-preload-probe.mjs");
for (const mode of ["mock-win", "mock-linux", "native"]) {
	const result = spawnSync(process.execPath, [helper, mode, preload], { encoding: "utf8", windowsHide: true, timeout: 30000 });
	assert.equal(result.status, 0, `${mode}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
	assert.equal(JSON.parse(result.stdout.trim()).passed, true);
}
const runner = readFileSync(resolve(import.meta.dirname, "../src/agents/agent-runner.ts"), "utf8");
assert.ok(runner.includes('preloadArgs.push("--import", pathToFileURL(preload).href)'));
assert.ok(runner.includes('args: [...preloadArgs, cliPath, ...args]'));
assert.ok(runner.includes('if (!existsSync(preload)) throw new Error(`AgentFlux background preload not found:'));
assert.ok(runner.includes("detached: true,"), "do not change parent-exit survival to suppress windows");
if (process.platform === "win32") {
	const workspaceRoot = resolve(import.meta.dirname, "../.agentflux/test-workspaces");
	mkdirSync(workspaceRoot, { recursive: true });
	const workspace = mkdtempSync(resolve(workspaceRoot, "missing-preload-"));
	try {
		const bundled = resolve(workspace, "runner.mjs");
		await build({ entryPoints: [resolve(import.meta.dirname, "../src/agents/agent-runner.ts")], outfile: bundled, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
		const isolated = await import(pathToFileURL(bundled).href);
		const result = await isolated.runAgent({ cwd: workspace, sessionId: "preflight-test", agent: { name: "preflight-test", role: "reviewer", tools: ["read"] }, task: "Do not start a model" });
		assert.equal(result.exitCode, 72);
		assert.match(result.errorMessage, /background preload not found/);
		assert.equal(result.usage.cost, 0);
		assert.equal(result.usage.turns, 0);
		assert.equal(existsSync(resolve(workspace, ".agentflux/runtime/runs.json")), false, "missing package asset must not leave a starting Run");
		assert.equal(existsSync(resolve(workspace, ".agentflux/runtime/active-context.json")), false);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
}
console.log("Background preload checks passed (Windows/POSIX policy, ESM, overloads, callbacks, promises, native failures, timeout and cancellation)");
