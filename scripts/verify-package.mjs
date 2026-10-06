import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "..");
const stage = mkdtempSync(join(tmpdir(), "agentflux-pack-check-"));
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
	assert.equal(result.status, 0, `${command} failed: ${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`);
	return result.stdout;
}
try {
	const npmCli = process.env.npm_execpath || join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
	const packed = JSON.parse(run(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", stage], { cwd: root }))[0];
	const members = packed.files.map(file => file.path);
	const assets = ["entry.js", "host-entry.ts", "subagent-entry.js", "background-preload.mjs"];
	for (const name of assets) assert.ok(members.includes(`dist/extension/${name}`), `missing ${name}`);
	assert.ok(members.includes("README.md"));
	assert.ok(!members.some(file => /(^|\/)(node_modules|src|tests|\.pi|\.codex)(\/|$)|^dist\/(host|contracts)\/|^\.agentflux\/(runtime|test-results|test-workspaces)\/|(^|\/)\.env($|\.)/.test(file)), "private/development assets in package");
	const unpack = join(stage, "unpack"); mkdirSync(unpack);
	run("tar", ["-xzf", packed.filename, "-C", "unpack"], { cwd: stage });
	const packageRoot = join(unpack, "package");
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.extensions, ["./dist/extension/host-entry.ts"]);
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=1.0.0");
	assert.equal(manifest.engines.node, ">=22.19.0");
	for (const name of assets) assert.equal(hash(join(packageRoot, "dist/extension", name)), hash(join(root, "dist/extension", name)));
	for (const name of ["entry.js", "subagent-entry.js"]) {
		run(process.execPath, ["--check", join(packageRoot, "dist/extension", name)]);
		// Native imports prove syntax/export shape, not Host SDK module identity.
		assert.equal(typeof (await import(pathToFileURL(join(root, "dist/extension", name)).href)).default, "function");
	}
	const hostRoot = getPackageDir();
	const hostManifest = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8"));
	const cli = join(hostRoot, typeof hostManifest.bin === "string" ? hostManifest.bin : hostManifest.bin.pi);
	const cwd = join(stage, "workspace"), agentDir = join(stage, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
	const stdout = run(process.execPath, [cli, "--offline", "--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "-e", join(packageRoot, "dist/extension/host-entry.ts")], {
		cwd, input: '{"id":"package-state","type":"get_state"}\n', env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	});
	const frames = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
	assert.ok(frames.some(event => event.type === "response" && event.id === "package-state" && event.success));
	assert.ok(frames.some(event => event.type === "extension_ui_request" && event.method === "notify" && event.message?.startsWith("AgentFlux ready")), "unpacked Host wrapper did not initialize");
	assert.ok(!frames.some(event => event.type === "extension_error"));
	console.log(JSON.stringify({ passed: true, version: manifest.version, integrity: packed.integrity, assets, hostVersion: hostManifest.version, offlineLoader: true, providerRequests: 0 }));
} finally {
	rmSync(stage, { recursive: true, force: true });
}
