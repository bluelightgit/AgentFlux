import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

interface Options {
	oldPid?: number;
	model?: string;
	provider?: string;
	thinking?: string;
	operation: "new" | "continue" | "retry";
	parentTaskId?: string;
	parentExecutionId?: string;
}

const root = resolve(import.meta.dirname, "../..");
const baseEvidencePath = join(root, ".agentflux", "test-results", "multirole-latest.json");
const reportDir = join(root, ".agentflux", "test-results", "dogfood");
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmArgs = (args: string[]): string[] => process.platform === "win32"
	? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), ...args]
	: args;

function parseOptions(argv: string[]): Options {
	const options: Options = { operation: "new" };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--old-pid" || arg === "--model" || arg === "--provider" || arg === "--thinking" || arg === "--operation" || arg === "--parent-task" || arg === "--parent-execution") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
			if (arg === "--old-pid") options.oldPid = Number(value);
			else if (arg === "--model") options.model = value;
			else if (arg === "--provider") options.provider = value;
			else if (arg === "--thinking") options.thinking = value;
			else if (arg === "--operation") {
				if (value !== "new" && value !== "continue" && value !== "retry") throw new Error(`invalid operation: ${value}`);
				options.operation = value;
			} else if (arg === "--parent-task") options.parentTaskId = value;
			else options.parentExecutionId = value;
		} else if (arg === "--help" || arg === "-h") {
			console.log("Usage: npm run dogfood:restart -- [--old-pid <pid>] [--model <model>] [--provider <provider>] [--thinking <level>] [--operation new|continue|retry] [--parent-task <id>] [--parent-execution <id>]");
			process.exit(0);
		} else throw new Error(`unknown option: ${arg}`);
	}
	if (options.oldPid !== undefined && (!Number.isInteger(options.oldPid) || options.oldPid < 1)) throw new Error("--old-pid must be a positive integer");
	if (options.oldPid === process.pid || options.oldPid === process.ppid) throw new Error("refusing to stop the supervisor or its parent; pass an explicit Pi process PID");
	return options;
}

function git(args: string[]): string {
	try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trimEnd(); }
	catch { return ""; }
}

function stopOldPi(pid: number | undefined): { requested: boolean; stopped: boolean; detail?: string } {
	if (pid === undefined) return { requested: false, stopped: false };
	if (process.platform === "win32") {
		const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { cwd: root, encoding: "utf8", windowsHide: true });
		const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-1000);
		return { requested: true, stopped: result.status === 0, detail };
	}
	try {
		process.kill(pid, "SIGTERM");
		return { requested: true, stopped: true, detail: "SIGTERM sent" };
	} catch (error) {
		return { requested: true, stopped: false, detail: String(error) };
	}
}

function tail(value: unknown, limit = 8000): string {
	return String(value ?? "").slice(-limit);
}

function main(): void {
	const options = parseOptions(process.argv.slice(2));
	const iterationId = `iteration-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
	const requestedTaskId = `dogfood-task-${randomUUID()}`;
	const requestedExecutionId = `dogfood-execution-${randomUUID()}`;
	const sourceCommit = git(["rev-parse", "HEAD"]);
	const branch = git(["branch", "--show-current"]);
	const changedFiles = git(["status", "--porcelain", "--untracked-files=all"])
		.split("\n").filter(Boolean).map(line => line.length > 3 ? line.slice(3) : line);
	const envOldPid = Number(process.env.AGENTFLUX_DOGFOOD_OLD_PID);
	const configuredOldPid = Number.isInteger(envOldPid) && envOldPid > 0 ? envOldPid : undefined;
	const oldPi = stopOldPi(options.oldPid ?? configuredOldPid);
	const build = spawnSync(npmCommand, npmArgs(["run", "build"]), {
		cwd: root,
		encoding: "utf8",
		windowsHide: true,
		timeout: 300_000,
		env: process.env,
	});
	const buildStatus = {
		exitCode: build.status,
		success: build.status === 0 && !build.error,
		timedOut: (build.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
		error: build.error ? String(build.error) : undefined,
		stdoutTail: tail(build.stdout),
		stderrTail: tail(build.stderr),
	};
	let test: ReturnType<typeof spawnSync> | undefined;
	let evidence: any;
	if (buildStatus.success) {
		rmSync(baseEvidencePath, { force: true });
		const env: NodeJS.ProcessEnv = {
			...process.env,
			AGENTFLUX_LIVE_BUILT: "1",
			AGENTFLUX_DOGFOOD_TASK_ID: requestedTaskId,
			AGENTFLUX_DOGFOOD_EXECUTION_ID: requestedExecutionId,
		};
		if (options.provider) env.AGENTFLUX_LIVE_PROVIDER_ID = options.provider;
		if (options.model) {
			env.AGENTFLUX_LIVE_MODEL_PRO = options.model;
			env.AGENTFLUX_LIVE_MODEL_FLASH = options.model;
		}
		if (options.thinking) env.AGENTFLUX_LIVE_THINKING = options.thinking;
		test = spawnSync(npmCommand, npmArgs(["run", "test:live:multirole"]), {
			cwd: root,
			encoding: "utf8",
			windowsHide: true,
			timeout: 420_000,
			env,
		});
		if ((test.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" && test.pid && process.platform === "win32") {
			spawnSync("taskkill", ["/PID", String(test.pid), "/T", "/F"], { windowsHide: true });
		}
		try { evidence = JSON.parse(readFileSync(baseEvidencePath, "utf8")); } catch { evidence = undefined; }
	}
	const report = {
		iterationId,
		createdAt: new Date().toISOString(),
		branch,
		sourceCommit,
		changedFiles,
		lineage: {
			operation: options.operation,
			parentTaskId: options.parentTaskId,
			parentExecutionId: options.parentExecutionId,
			requestedTaskId,
			requestedExecutionId,
			actualTaskId: evidence?.task?.id,
			actualExecutionId: evidence?.task?.executionId,
		},
		oldPi,
		build: buildStatus,
		newPi: {
			exitCode: test?.status ?? null,
			timedOut: (test?.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
			stdoutTail: tail(test?.stdout),
			error: test?.error ? String(test.error) : undefined,
			stderrTail: tail(test?.stderr),
		},
		evidence,
		passed: buildStatus.success && test?.status === 0 && evidence?.builtExtension === true && evidence?.marker === true,
	};
	mkdirSync(reportDir, { recursive: true });
	const reportPath = join(reportDir, `${iterationId}.json`);
	writeFileSync(reportPath, JSON.stringify(report, null, 2));
	console.log(JSON.stringify({ ...report, reportPath }, null, 2));
	if (!report.passed) process.exitCode = 1;
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
