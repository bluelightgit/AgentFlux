process.stdout.write(`${JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    model: "quota-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    errorMessage: "Monthly usage limit reached",
    content: [],
  },
})}\n`);
process.exit(0);
