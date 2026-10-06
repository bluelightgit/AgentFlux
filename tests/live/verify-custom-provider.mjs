// 零成本真实链路验证：本地 mock OpenAI 兼容端点 + PI_CODING_AGENT_DIR provider。
// 验证 live 测试配置化的核心机制：
//   1. models.json providers 段（baseUrl/api/apiKey/models）被 pi 读取
//   2. --model provider/model 与 --thinking 生效
//   3. 请求真正发送到自定义 baseUrl 并携带 apiKey
// 注意：必须用异步 spawn，spawnSync 会阻塞本进程事件循环，mock server
// 无法响应请求（表现为 pi 挂起）。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPiCliPath } from "../../src/core/pi-runtime.ts";

const requests = [];
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		requests.push({ url: req.url, auth: req.headers.authorization ?? null });
		if (req.url?.endsWith("/chat/completions")) {
			// SSE 流式响应（pi 的 openai-completions 走流式）
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: Date.now(), model: "mock-model", choices: [{ index: 0, delta: { role: "assistant", content: "REPLY_FROM_MOCK" }, finish_reason: null }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: Date.now(), model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
			res.end("data: [DONE]\n\n");
		} else {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		}
	});
});
await new Promise((d) => server.listen(0, "127.0.0.1", d));
const port = server.address().port;
const agentDir = mkdtempSync(join(tmpdir(), "agentflux-live-ci-"));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({
	providers: {
		"agentflux-ci": {
			baseUrl: `http://127.0.0.1:${port}/v1`,
			api: "openai-completions",
			apiKey: "ci-secret-key",
			models: [{ id: "mock-model", reasoning: false, input: ["text"], contextWindow: 128000 }],
		},
	},
}, null, 2));
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "agentflux-ci": { type: "api_key", key: "ci-secret-key" } }, null, 2));

const piCli = getPiCliPath();
const child = spawn(process.execPath, [
	piCli, "--mode", "json", "-p", "--no-extensions", "--no-skills",
	"--model", "agentflux-ci/mock-model", "--thinking", "off",
	"请只回复精确文本 REPLY_FROM_MOCK",
], { cwd: resolve(import.meta.dirname, "../.."), windowsHide: true, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
const exitCode = await new Promise((d) => {
	const t = setTimeout(() => { child.kill(); d("TIMEOUT"); }, 30_000);
	child.on("close", (code) => { clearTimeout(t); d(code ?? "closed"); });
});
const first = requests[0];
const ok = exitCode === 0
	&& requests.length > 0
	&& first?.url?.endsWith("/chat/completions")
	&& first?.auth === "Bearer ci-secret-key"
	&& stdout.includes("REPLY_FROM_MOCK");
console.log(`[result] exit=${exitCode} requests=${requests.length} url=${first?.url ?? "none"} auth=${first?.auth ?? "none"} answered=${stdout.includes("REPLY_FROM_MOCK")}`);
console.log(`[result] ${ok ? "CUSTOM_PROVIDER_OK" : "CUSTOM_PROVIDER_FAILED"}`);
server.close();
rmSync(agentDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
