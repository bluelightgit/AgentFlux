if (process.env.AGENTFLUX_TEST_CAPTURE) {
  require("node:fs").writeFileSync(process.env.AGENTFLUX_TEST_CAPTURE, JSON.stringify({
    argv: process.argv.slice(2),
    agent: process.env.AGENTFLUX_AGENT_NAME,
    instanceId: process.env.AGENTFLUX_AGENT_INSTANCE_ID,
    runId: process.env.AGENTFLUX_RUN_ID,
    policy: JSON.parse(process.env.AGENTFLUX_COMMUNICATION_POLICY || "{}"),
    capability: JSON.parse(process.env.AGENTFLUX_CAPABILITY_POLICY || "{}"),
  }), "utf-8");
}
const event = {
  type: "message_end",
  message: {
    role: "assistant",
    model: "test-model",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
    content: [{ type: "text", text: "message processed" }],
  },
};
process.stdout.write(JSON.stringify(event) + "\n");
