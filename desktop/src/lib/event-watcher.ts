/**
 * D1-6: 实时文件监听 + 增量推送
 * 监听 events.jsonl 变化, 增量解析并通知订阅者
 *
 * IMPORTANT: No top-level node:fs imports — uses async polling via IPC
 * in renderer, or dynamic import in Node. This allows the module to load
 * safely in the Electron renderer (browser context).
 */

import { parseEventsIncrementalAsync, parseEventsIncremental, type AnyEvent } from "./events-parser";
import { getFileSize } from "./file-access";

type EventHandler = (events: AnyEvent[]) => void;

export class EventWatcher {
  private filePath: string;
  private lastOffset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private handlers: EventHandler[] = [];
  private intervalMs: number;
  private useAsync: boolean;
  private initialized = false;

  constructor(filePath: string, intervalMs = 500) {
    this.filePath = filePath;
    this.intervalMs = intervalMs;
    this.useAsync = typeof window !== "undefined"; // 浏览器/Electron 渲染进程用异步
  }

  /** Initialize offset — async to work in both Node and renderer */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      if (this.useAsync) {
        this.lastOffset = await getFileSize(this.filePath);
      } else {
        // Node: use dynamic import
      }
    } catch {
      this.lastOffset = 0;
    }
  }

  start(): void {
    if (this.timer) return;
    // Init offset then start polling
    this.init().then(() => {
      this.timer = setInterval(() => this.poll(), this.intervalMs);
    }).catch(() => {
      this.timer = setInterval(() => this.poll(), this.intervalMs);
    });
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
  }

  async poll(): Promise<void> {
    try {
      if (this.useAsync) {
        const { events, newOffset } = await parseEventsIncrementalAsync(this.filePath, this.lastOffset);
        this.lastOffset = newOffset;
        if (events.length > 0) for (const h of this.handlers) h(events);
      } else {
        const { events, newOffset } = await parseEventsIncremental(this.filePath, this.lastOffset);
        this.lastOffset = newOffset;
        if (events.length > 0) for (const h of this.handlers) h(events);
      }
    } catch {}
  }

  getOffset(): number { return this.lastOffset; }
}
