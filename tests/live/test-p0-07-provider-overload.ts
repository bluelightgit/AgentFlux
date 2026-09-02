import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadLiveConfig } from "./live-config";

/**
 * 生产 dist provider-overload 验证：本地 OpenAI-compatible SSE provider 先返回
 * 短暂 503，再恢复；真实 Planner/DAG/quality-gate 链路必须重试并完成。
 * provider、模型和 thinking 仍由 live 配置决定，mock 只模拟传输故障。
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `p0-07-provider-overload-${process.pid}`);
const reportPath = join(sourceRoot, ".agentflux", "test-results", "p0-07-provider-overload-latest.json");
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

interface RequestRecord {
	sequence: number;
	kind: "main" | "planner" | "worker" | "judge" | "unknown";
	status: number;
	model?: string;
	toolNames: string[];
	error?: string;
}

function git(args: string[]): string {
	try { return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8", windowsHide: true }).trimEnd(); }
	catch { return ""; }
}

function readJson(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function sendSse(res: ServerResponse, model: string, content: string): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const chunks = [
		{ id: "agentflux-live", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
		{ id: "agentflux-live", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	];
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.end("data: [DONE]\n\n");
}

function sendToolCall(res: ServerResponse, model: string, name: string, args: Record<string, unknown>): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const call = {
		id: "call-agentflux-live",
		type: "function",
		function: { name, arguments: JSON.stringify(args) },
		index: 0,
	};
	const chunks = [
		{ id: "agentflux-live", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] },
		{ id: "agentflux-live", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
	];
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.end("data: [DONE]\n\n");
}

function toolNames(body: any): string[] {
	return Array.isArray(body?.tools)
		? body.tools.map((tool: any) => tool?.function?.name ?? tool?.name).filter((name: unknown): name is string => typeof name === "string")
		: [];
}

function classify(body: any, names: string[]): RequestRecord["kind"] {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	const text = JSON.stringify(messages);
	if (names.includes("flux_workflow") || names.includes("flux_agent") || names.includes("flux_task")) return "main";
	if (text.includes("decompose it into a structured DAG")) return "planner";
	if (text.toLowerCase().includes("quality gate checker")) return "judge";
	if (text.includes("provider-overload-live") || text.includes("BUILT_PROVIDER_OVERLOAD_NODE_OK")) return "worker";
	return "unknown";
}

function criteriaFromJudgePrompt(body: any): string[] {
	const text = JSON.stringify(body?.messages ?? []);
	const match = text.match(/## Acceptance Criteria\n([\s\S]*?)\n\n## Agent Output/);
	if (!match) return ["Output contains BUILT_PROVIDER_OVERLOAD_NODE_OK"];
	return [...match[1].matchAll(/^\s*\d+\.\s+(.+)$/gm)].map(item => item[1].trim()).filter(Boolean);
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("provider mock did not expose a TCP port");
	return address.port;
}

interface MainResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error?: string;
}

function stopTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
	else {
		try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
	}
}

function runMain(config: ReturnType<typeof loadLiveConfig>, extensionEntry: string): Promise<MainResult> {
	const prompt = [
		"严格只调用一次 AgentFlux flux_workflow 工具，不要调用其他 AgentFlux 工具。",
		"action=run。任务要求：创建一个只有一个 implementer 节点的 Workflow；该节点最终必须输出 BUILT_PROVIDER_OVERLOAD_NODE_OK，质量门必须验证这个输出；DAG 完成后主 Agent 输出 P0_07_PROVIDER_OVERLOAD_OK。",
	].join("\n");
	const child = spawn(process.execPath, [
		piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", extensionEntry,
		"--no-skills", "--tools", "read,grep,find,ls,flux_workflow", ...config.cliArgs(config.mainModel), prompt,
	], { cwd: fixtureRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: config.env });
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", value => { stdout += value.toString(); });
	child.stderr?.on("data", value => { stderr += value.toString(); });
	return new Promise(resolveResult => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			stopTree(child);
			resolveResult({ status: null, signal: "SIGTERM", stdout, stderr, error: "provider-overload Main timed out" });
		}, 180_000);
		child.on("error", error => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ status: 1, signal: null, stdout, stderr, error: String(error) });
		});
		child.on("close", (status, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ status, signal, stdout, stderr });
		});
	});
}

async function main(): Promise<void> {
	if (process.env.AGENTFLUX_LIVE_BUILT !== "1") throw new Error("provider-overload live test requires AGENTFLUX_LIVE_BUILT=1");
	if (!existsSync(join(sourceRoot, "dist", "extension", "entry.js"))) throw new Error("production dist entry is missing; run npm run build first");
	mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
	const requests: RequestRecord[] = [];
	let transientFailuresRemaining = 2;
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = "";
		req.on("data", chunk => { raw += chunk.toString(); });
		req.on("end", () => {
			let body: any = {};
			try { body = JSON.parse(raw); } catch {}
			const names = toolNames(body);
			const kind = classify(body, names);
			const sequence = requests.length + 1;
			if (!req.url?.endsWith("/chat/completions")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [] }));
				return;
			}
			if (kind !== "main" && transientFailuresRemaining > 0) {
				transientFailuresRemaining--;
				const error = `provider overloaded: transient test failure ${sequence}`;
				requests.push({ sequence, kind, status: 503, model: body.model, toolNames: names, error });
				res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
				res.end(JSON.stringify({ error: { message: error, type: "server_error", code: "overloaded" } }));
				return;
			}
			requests.push({ sequence, kind, status: 200, model: body.model, toolNames: names });
			const messages = Array.isArray(body.messages) ? body.messages : [];
			const toolResults = messages.filter((message: any) => message?.role === "tool" || message?.role === "toolResult").length;
			if (kind === "main" && names.includes("flux_workflow")) {
				if (toolResults === 0) {
					sendToolCall(res, body.model ?? "configured-model", "flux_workflow", { action: "run", task: "Create one implementer node that emits BUILT_PROVIDER_OVERLOAD_NODE_OK and pass it through the quality gate.", name: "provider-overload-workflow" });
				} else {
					sendSse(res, body.model ?? "configured-model", "P0_07_PROVIDER_OVERLOAD_OK");
				}
				return;
			}
			if (kind === "planner") {
				const dag = {
					description: "provider overload recovery workflow",
					nodes: [{
						id: "provider-node",
						title: "provider recovery worker",
						role: "implementer",
						dependsOn: [],
						parallelizable: true,
						acceptanceCriteria: ["Output contains BUILT_PROVIDER_OVERLOAD_NODE_OK"],
						files: [],
						description: "Respond exactly BUILT_PROVIDER_OVERLOAD_NODE_OK.",
					}],
				};
				sendSse(res, body.model ?? "configured-model", JSON.stringify(dag));
				return;
			}
			if (kind === "judge") {
				const criteria = criteriaFromJudgePrompt(body);
				sendSse(res, body.model ?? "configured-model", JSON.stringify({ passed: true, criteriaResults: criteria.map(criterion => ({ criterion, met: true })), feedback: "All configured criteria met after provider recovery." }));
				return;
			}
			sendSse(res, body.model ?? "configured-model", "BUILT_PROVIDER_OVERLOAD_NODE_OK");
		});
	});
	const port = await listen(server);
	const envKeys = ["AGENTFLUX_LIVE_PROVIDER_ID", "AGENTFLUX_LIVE_BASE_URL", "AGENTFLUX_LIVE_API", "AGENTFLUX_LIVE_API_KEY", "AGENTFLUX_LIVE_THINKING"] as const;
	const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
	let config: ReturnType<typeof loadLiveConfig> | undefined;
	const startedAt = Date.now();
	try {
		process.env.AGENTFLUX_LIVE_PROVIDER_ID = "agentflux-overload";
		process.env.AGENTFLUX_LIVE_BASE_URL = `http://127.0.0.1:${port}/v1`;
		process.env.AGENTFLUX_LIVE_API = "openai-completions";
		process.env.AGENTFLUX_LIVE_API_KEY = "agentflux-local-test";
		if (!process.env.AGENTFLUX_LIVE_THINKING) process.env.AGENTFLUX_LIVE_THINKING = "off";
		config = loadLiveConfig("p0-07-provider-overload");
		mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
		mkdirSync(join(fixtureRoot, "sessions"), { recursive: true });
		writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux provider-overload fixture\n");
		writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
			budget: { max_cost_per_task: 0.50, max_iterations: 3, max_turns_per_task: 12, max_input_tokens_per_task: 100_000, max_parallel_agents: 2, max_wall_clock_seconds: 120 },
			quality_gate: { model: config.judgeModel, timeout_ms: 60_000 },
			pricing: { enable_remote_fetch: false },
		}, null, 2));
		writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(config.fluxModelsJson(), null, 2));
		const extensionDir = join(fixtureRoot, "dist", "extension");
		mkdirSync(extensionDir, { recursive: true });
		for (const file of ["entry.js", "subagent-entry.js"]) writeFileSync(join(extensionDir, file), readFileSync(join(sourceRoot, "dist", "extension", file)));
		const result = await runMain(config, join(extensionDir, "entry.js"));
		const tasks = readJson(join(fixtureRoot, ".agentflux", "runtime", "tasks.json"))?.tasks ?? [];
		const runs = readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs ?? [];
		const dagDirs = existsSync(join(fixtureRoot, ".agentflux", "runtime", "runs")) ? ["runs"] : [];
		const providerErrorResponses = requests.filter(request => request.status === 503);
		const retryEvents = runs.flatMap((run: any) => run.recentEvents ?? []).filter((event: any) => ["retry", "retry_backoff", "provider_error"].includes(event.type));
		const workflowTask = tasks.find((task: any) => task.resource?.type === "workflow");
		const passed = result.status === 0
			&& `${result.stdout}\n${result.stderr}`.includes("P0_07_PROVIDER_OVERLOAD_OK")
			&& workflowTask?.status === "completed"
			&& runs.some((run: any) => run.status === "completed" && run.role === "implementer" && String(run.lastProgressSummary ?? "").includes("BUILT_PROVIDER_OVERLOAD_NODE_OK"))
			&& providerErrorResponses.length >= 2
			&& requests.length > providerErrorResponses.length
			&& retryEvents.length > 0;
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
			main: { exitCode: result.status, signal: result.signal, error: result.error ? String(result.error) : undefined },
			providerErrorResponses,
			requests,
			retryEvents,
			tasks,
			runs,
			dagDirs,
			stdoutTail: String(result.stdout ?? "").slice(-8000),
			stderrTail: String(result.stderr ?? "").slice(-8000),
			passed,
		};
		writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
		console.log(JSON.stringify(evidence, null, 2));
		if (!passed) throw new Error(`provider-overload evidence failed; report=${reportPath}`);
	} finally {
		server.close();
		config?.cleanup();
		for (const key of envKeys) {
			if (oldEnv[key] === undefined) delete process.env[key];
			else process.env[key] = oldEnv[key];
		}
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
