// 只由本地确定性测试使用；通过真实 child process/统一 Run Registry，不调用 Provider。
const fs = require('node:fs');
const [mode, receipt] = process.argv.slice(2);
fs.appendFileSync(receipt, JSON.stringify({ pid: process.pid, role: process.env.AGENTFLUX_AGENT_ROLE, runId: process.env.AGENTFLUX_RUN_ID, argv: process.argv.slice(4), capability: JSON.parse(process.env.AGENTFLUX_CAPABILITY_POLICY || '{}') }) + '\n');
const message = () => process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'judge-test', stopReason: 'stop', usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } }, content: [{ type: 'text', text: mode === 'invalid' ? 'not JSON' : JSON.stringify({ passed: true, feedback: 'ok', criteriaResults: [{ criterion: 'marker', met: true }] }) }] } }) + '\n');
if (mode === 'hang') setTimeout(message, 30000);
else if (mode === 'online') { message(); setTimeout(() => {}, 700); }
else message();
