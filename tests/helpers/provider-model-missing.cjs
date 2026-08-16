// 模型不可用模拟：第一次调用报 model not found（触发模型降级），
// 第二次（降级后的模型）正常返回。调用次数通过状态文件跨进程计数。
const stateFile = process.env.AGENTFLUX_CRASH_STATE;
let attempt = 1;
if (stateFile) {
  try {
    attempt = Number(require("node:fs").readFileSync(stateFile, "utf-8").trim()) + 1;
  } catch { /* 首次调用无状态文件 */ }
  require("node:fs").writeFileSync(stateFile, String(attempt), "utf-8");
}
const failed = attempt === 1;
const event = {
  type: "message_end",
  message: {
    role: "assistant",
    model: failed ? "unavailable-model" : "fallback-model",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
    content: failed ? [] : [{ type: "text", text: "fallback model succeeded" }],
    errorMessage: failed ? "model not found: unavailable-model" : undefined,
  },
};
process.stdout.write(JSON.stringify(event) + "\n");
