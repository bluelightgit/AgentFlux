const delayMs = Math.max(100, Number(process.env.AGENTFLUX_TEST_EXIT_DELAY_MS || 700));
const errorMessage = process.env.AGENTFLUX_TEST_PROVIDER_ERROR || undefined;

process.stdout.write(`${JSON.stringify({
  type: "tool_execution_start",
  toolName: "read",
  args: { path: "src/example.ts" },
})}\n`);

setTimeout(() => {
  process.stdout.write(`${JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      model: "live-test-model",
      provider: "live-test-provider",
      usage: {
        input: 21,
        output: 4,
        cacheRead: 8,
        cacheWrite: 2,
        totalTokens: 33,
        cost: { total: 0.012345 },
      },
      content: errorMessage ? [] : [{ type: "text", text: "online telemetry ready" }],
      errorMessage,
    },
  })}\n`);
}, 50);

setTimeout(() => process.exit(0), delayMs);
