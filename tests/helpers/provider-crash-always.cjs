// provider 持续崩溃模拟：每次调用都返回瞬时错误（500），重试无法恢复。
const event = {
  type: "message_end",
  message: {
    role: "assistant",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    content: [],
    errorMessage: "502 Bad Gateway",
  },
};
process.stdout.write(JSON.stringify(event) + "\n");
