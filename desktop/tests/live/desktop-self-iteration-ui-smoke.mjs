import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const endpoint = process.env.AGENTFLUX_CDP_ENDPOINT ?? 'http://127.0.0.1:9223';
const projectRoot = resolve(import.meta.dirname, '../../..');
const fixture = resolve(projectRoot, '.agentflux/test-results/desktop-self-iteration-target.txt');
const startedAt = Date.now();

const sleep = (ms) => new Promise((resolveDone) => setTimeout(resolveDone, ms));

async function connect() {
  const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
  const target = targets.find((entry) => entry.type === 'page' && entry.url.includes('/desktop/dist/index.html'));
  if (!target?.webSocketDebuggerUrl) throw new Error('AgentFlux Desktop CDP target was not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveDone, reject) => {
    socket.addEventListener('open', resolveDone, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolveDone, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolveDone, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, call };
}

async function evaluate(call, expression) {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? 'Renderer evaluation failed');
  return response.result.value;
}

mkdirSync(resolve(fixture, '..'), { recursive: true });
writeFileSync(fixture, 'BEFORE\n', 'utf8');
const { socket, call } = await connect();
const report = { ok: false, model: 'octopus-anthropic/deepseek-v4-flash', fixture, checks: {} };

try {
  await call('Page.bringToFront');
  await call('Emulation.clearDeviceMetricsOverride');
  const dispatched = await evaluate(call, `(async () => {
    const button = (label) => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === label);
    button('Workbench')?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    button('New Task')?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const setValue = (selector, value) => {
      const element = document.querySelector(selector);
      if (!element) return false;
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const fieldsReady = setValue('[aria-label="Task title"]', 'Desktop self iteration smoke')
      && setValue('[aria-label="Initial prompt"]', ${JSON.stringify(`这是一次受控的 Desktop 自我迭代冒烟测试。请直接读取 ${fixture}，将文件内容从 BEFORE 改为 AFTER，确认读取结果确实为 AFTER 后结束任务。不要修改其他文件，不要创建子代理，只回复 SELF_ITERATION_OK。`)})
      && setValue('[aria-label="Work style"]', 'direct');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const dispatch = button('Dispatch task');
    if (!fieldsReady || !dispatch || dispatch.disabled) return false;
    dispatch.click();
    return true;
  })()`);
  report.checks.dispatchedFromDesktop = dispatched;
  if (!dispatched) throw new Error('New Task form could not be dispatched');

  const deadline = Date.now() + 120_000;
  let status = '';
  while (Date.now() < deadline) {
    const content = readFileSync(fixture, 'utf8').trim();
    status = await evaluate(call, `(() => {
      const label = [...document.querySelectorAll('dt')].find((node) => node.textContent.trim() === 'Status');
      return label?.nextElementSibling?.textContent?.trim().toLowerCase() ?? '';
    })()`);
    if (content === 'AFTER' && ['done', 'failed'].includes(status)) break;
    await sleep(500);
  }

  const content = readFileSync(fixture, 'utf8').trim();
  report.checks.workspaceChanged = content === 'AFTER';
  report.checks.runtimeStatus = status;
  const eventLines = readFileSync(resolve(projectRoot, '.agentflux/events.jsonl'), 'utf8').trim().split(/\r?\n/);
  const execution = eventLines.map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .findLast((event) => event?.type === 'task.execution' && event.ts >= startedAt && event.workStyle === 'direct');
  report.checks.directSelectedByUser = execution?.selectedBy === 'user';
  report.ok = report.checks.dispatchedFromDesktop && report.checks.workspaceChanged
    && report.checks.runtimeStatus === 'done' && report.checks.directSelectedByUser;
  if (!report.ok) throw new Error(`Self iteration checks failed: ${JSON.stringify(report.checks)}`);
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
} finally {
  socket.close();
  rmSync(fixture, { force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (!report.ok) process.exitCode = 1;
