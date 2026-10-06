import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getPiCliPath, loadLiveConfig } from "./live-config";

/**
 * Production package/resource boundary validation. npm pack must contain only
 * the declared dist/config surface (no source or tests), and a fresh Pi loads
 * the extracted package entry plus its extracted subagent entry.
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const reportPath = join(sourceRoot, ".agentflux", "test-results", "p0-07-package-boundary-latest.json");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `p0-07-package-boundary-${process.pid}`);
const piCli = getPiCliPath();
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmArgs = (args: string[]): string[] => process.platform === "win32"
	? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), ...args]
	: args;

function git(args: string[]): string {
	try { return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8", windowsHide: true }).trimEnd(); }
	catch { return ""; }
}

function readJson(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function tail(value: unknown, limit = 5000): string { return String(value ?? "").slice(-limit); }

async function main(): Promise<void> {
	if (process.env.AGENTFLUX_LIVE_BUILT !== "1") throw new Error("package boundary live test requires AGENTFLUX_LIVE_BUILT=1");
	if (!existsSync(join(sourceRoot, "dist", "extension", "entry.js"))) throw new Error("production dist entry is missing; run npm run build first");
	const config = loadLiveConfig("p0-07-package-boundary");
	const packageStage = mkdtempSync(join(tmpdir(), "agentflux-package-stage-"));
	const unpackRoot = join(packageStage, "unpack");
	mkdirSync(unpackRoot, { recursive: true });
	const startedAt = Date.now();
	try {
		mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
		mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
		const packed = spawnSync(npmCommand, npmArgs(["pack", "--json", "--pack-destination", packageStage]), { cwd: sourceRoot, encoding: "utf8", windowsHide: true, timeout: 300_000, env: process.env });
		let packRecords: any[] = [];
		try { packRecords = JSON.parse(String(packed.stdout ?? "")); } catch {
			const match = String(packed.stdout ?? "").match(/\[[\s\S]*\]/);
			if (match) { try { packRecords = JSON.parse(match[0]); } catch {} }
		}
		const archiveName = packRecords[0]?.filename;
		const archivePath = archiveName ? join(packageStage, archiveName) : "";
		if (packed.status !== 0 || !archivePath || !existsSync(archivePath)) throw new Error(`npm pack failed: ${tail(packed.stderr)}${tail(packed.stdout)}`);
		const listing = spawnSync("tar", ["-tzf", archiveName], { cwd: packageStage, encoding: "utf8", windowsHide: true, timeout: 60_000 });
		if (listing.status !== 0) throw new Error(`tar listing failed: ${tail(listing.stderr)}`);
		const entries = String(listing.stdout ?? "").split(/\r?\n/).filter(Boolean);
		const extraction = spawnSync("tar", ["-xzf", archiveName, "-C", "unpack"], { cwd: packageStage, encoding: "utf8", windowsHide: true, timeout: 60_000 });
		if (extraction.status !== 0) throw new Error(`tar extraction failed: ${tail(extraction.stderr)}`);
		const extractedPackage = join(unpackRoot, "package");
		const packageEntry = join(extractedPackage, "dist", "extension", "host-entry.ts");
		const subagentEntry = join(extractedPackage, "dist", "extension", "subagent-entry.js");
		if (!existsSync(packageEntry) || !existsSync(subagentEntry)) throw new Error("packed extension entries are incomplete");
		// External peer/dev modules remain host-provided at runtime. A junction is
		// used only for this fixture so the extracted production package can boot.
		symlinkSync(join(sourceRoot, "node_modules"), join(extractedPackage, "node_modules"), "junction");
		writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux package boundary fixture\n");
		writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
			budget: { max_cost_per_task: 0.20, max_iterations: 2, max_wall_clock_seconds: 60 },
			pricing: { enable_remote_fetch: false },
		}, null, 2));
		writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(config.fluxModelsJson(), null, 2));
		const result = spawnSync(process.execPath, [
			piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", packageEntry,
			"--no-skills", "--tools", "flux_agent", ...config.cliArgs(config.mainModel),
			"严格只调用 AgentFlux flux_agent 工具：先 action=create，name=package-live，role=implementer；再 action=run，agent=package-live，background=false，task=只回复 PACKAGE_ENTRY_OK。收到成功结果后只输出 PACKAGE_MAIN_OK。",
		], { cwd: fixtureRoot, encoding: "utf8", windowsHide: true, timeout: 180_000, env: config.env });
		const runs = readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs ?? [];
		const tasks = readJson(join(fixtureRoot, ".agentflux", "runtime", "tasks.json"))?.tasks ?? [];
		const packageOnly = entries.every(entry => !entry.startsWith("package/src/") && !entry.startsWith("package/tests/") && !entry.includes("/src/") && !entry.includes("/tests/"));
		const bounded = entries.length <= 500 && lstatSync(packageEntry).size < 2_000_000 && lstatSync(subagentEntry).size < 500_000;
		const marker = `${result.stdout}\n${result.stderr}`.includes("PACKAGE_MAIN_OK") && `${result.stdout}\n${result.stderr}`.includes("PACKAGE_ENTRY_OK");
		const passed = packageOnly && bounded && result.status === 0 && marker
			&& tasks.some((task: any) => task.status === "completed")
			&& runs.some((run: any) => run.status === "completed" && String(run.lastProgressSummary ?? "").includes("PACKAGE_ENTRY_OK"));
		const evidence = {
			updatedAt: new Date().toISOString(),
			branch: git(["branch", "--show-current"]),
			sourceCommit: git(["rev-parse", "HEAD"]),
			changedFiles: git(["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean).map(line => line.length > 3 ? line.slice(3) : line),
			profile: config.profileName,
			configPath: config.configPath,
			provider: config.providerId,
			models: { main: config.mainModel, planner: config.plannerModel, worker: config.workerModel, judge: config.judgeModel },
			thinking: config.thinking,
			builtExtension: true,
			wallClockMs: Date.now() - startedAt,
			package: { archiveName, entryCount: entries.length, entries, packageOnly, bounded, entryBytes: lstatSync(packageEntry).size, subagentBytes: lstatSync(subagentEntry).size },
			main: { exitCode: result.status, signal: result.signal, error: result.error ? String(result.error) : undefined },
			tasks,
			runs,
			marker,
			stdoutTail: tail(result.stdout, 8000),
			stderrTail: tail(result.stderr, 5000),
			passed,
		};
		writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
		console.log(JSON.stringify(evidence, null, 2));
		if (!passed) throw new Error(`package boundary evidence failed; report=${reportPath}`);
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
		rmSync(packageStage, { recursive: true, force: true });
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
