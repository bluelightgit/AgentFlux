// 在同一物理进程模拟 Pi 自动重试；所有原始 message_end 事件均保留。
const mode = process.argv[2];
const message = (stopReason, errorMessage) => ({ type: 'message_end', message: { role: 'assistant', model: 'test', stopReason,
  ...(errorMessage ? { errorMessage } : {}), usage: { input: 10, output: 2, cost: { total: 0.001 } },
  content: stopReason === 'stop' ? [{ type: 'text', text: 'RECOVERED' }] : [] } });
const rows = mode === 'error' ? [message('stop'), message('error')]
  : mode === 'abort' ? [message('stop'), message('aborted')]
  : [message('error', 'WebSocket error'), message('toolUse'), message('stop')];
process.stdout.write(rows.map(JSON.stringify).join('\n') + '\n');
