const endpoint = process.env.AGENTFLUX_CDP_ENDPOINT ?? 'http://127.0.0.1:9223';
const viewports = [
  { width: 1280, height: 800 },
  { width: 1024, height: 720 },
  { width: 800, height: 600 },
];

async function connect() {
  const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
  const target = targets.find((entry) => entry.type === 'page' && entry.url.includes('/desktop/dist/index.html'));
  if (!target?.webSocketDebuggerUrl) throw new Error('AgentFlux Desktop CDP target was not found');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP call timed out: ${method}`));
    }, 10_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, call };
}

const pause = (duration = 250) => new Promise((resolve) => setTimeout(resolve, duration));

async function evaluate(call, expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Renderer evaluation failed');
  return result.result.value;
}

async function clickText(call, text, scope = 'body') {
  return evaluate(call, `(() => {
    const label = ${JSON.stringify(text)};
    const root = document.querySelector(${JSON.stringify(scope)});
    const target = [...(root?.querySelectorAll('button') ?? [])].find((node) =>
      node.textContent.trim() === label || [...node.querySelectorAll('span')].some((span) => span.textContent.trim() === label)
    );
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

async function inspect(call, label, viewport) {
  const metrics = await evaluate(call, `(() => {
    const root = document.documentElement;
    const body = document.body;
    const overflow = [...document.querySelectorAll('*')]
      .filter((node) => {
        const overflowX = getComputedStyle(node).overflowX;
        return node.scrollWidth > node.clientWidth + 1 && !['auto', 'scroll', 'hidden', 'clip'].includes(overflowX);
      })
      .slice(0, 12)
      .map((node) => ({ tag: node.tagName, text: (node.textContent || '').trim().slice(0, 60), client: node.clientWidth, scroll: node.scrollWidth }));
    const navigation = document.querySelector('nav');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: { clientWidth: root.clientWidth, scrollWidth: Math.max(root.scrollWidth, body.scrollWidth) },
      navigationWidth: navigation?.getBoundingClientRect().width ?? 0,
      overflow,
    };
  })()`);
  const pageOverflow = metrics.document.scrollWidth > metrics.document.clientWidth + 1;
  if (pageOverflow) {
    throw new Error(`${label} ${viewport.width}x${viewport.height} overflow: ${JSON.stringify(metrics)}`);
  }
  return { label, ...metrics };
}

const { socket, call } = await connect();
await call('Page.enable');
await call('Runtime.enable');
await call('Page.bringToFront');
await call('Page.reload', { ignoreCache: true });
await pause(800);
const reports = [];

try {
  const initialFailureToasts = await evaluate(call, `new Promise((resolve) => setTimeout(() => resolve(
    [...document.querySelectorAll('[aria-label="Dismiss notification"]')].filter((node) =>
      node.parentElement?.textContent?.includes('failed')
    ).length
  ), 3500))`);
  if (initialFailureToasts !== 0) throw new Error(`Historical failure toasts were replayed: ${initialFailureToasts}`);

  const chrome = await evaluate(call, `(async () => {
    const button = (label) => document.querySelector('button[aria-label="' + label + '"]');
    button('Search and commands')?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const dialog = document.querySelector('[role="dialog"][aria-label="Search and commands"]');
    const searchFocused = dialog?.querySelector('input') === document.activeElement;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    const refresh = button('Refresh');
    const oldTitle = refresh?.title;
    refresh?.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const refreshWorked = Boolean(refresh?.title.startsWith('Last refreshed')) && refresh?.title !== oldTitle;

    const maximize = button('Toggle maximize window');
    maximize?.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const maximized = maximize?.title === 'Restore';
    maximize?.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const restored = maximize?.title === 'Maximize';
    return { dialogOpened: Boolean(dialog), searchFocused, refreshWorked, maximized, restored };
  })()`);
  if (Object.values(chrome).some((value) => !value)) throw new Error(`Desktop chrome check failed: ${JSON.stringify(chrome)}`);
  reports.push({ label: 'desktop-chrome', ...chrome, initialFailureToasts });

  for (const viewport of viewports) {
    await call('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
    await pause(300);

    if (!await clickText(call, 'Workbench')) {
      const labels = await evaluate(call, `[...document.querySelectorAll('button')].map((node) => node.textContent.trim()).filter(Boolean)`);
      throw new Error(`Workbench navigation entry was not found: ${JSON.stringify(labels)}`);
    }
    await pause();
    reports.push(await inspect(call, 'workbench', viewport));

    if (!await clickText(call, 'Agents')) throw new Error('Agents navigation entry was not found');
    await pause();
    reports.push(await inspect(call, 'agents-roster', viewport));
    for (const tab of ['Activity', 'Capabilities']) {
      if (!await clickText(call, tab, 'main')) throw new Error(`Agents ${tab} tab was not found`);
      await pause();
      reports.push(await inspect(call, `agents-${tab.toLowerCase()}`, viewport));
    }

    if (!await clickText(call, 'Activity')) throw new Error('Activity navigation entry was not found');
    await pause();
    reports.push(await inspect(call, 'activity', viewport));
  }
  console.log(JSON.stringify({ ok: true, reports }, null, 2));
} finally {
  socket.close();
}
