/**
 * D1-6: 实时文件监听 + 增量推送
 * 监听 events.jsonl 变化, 增量解析并通知订阅者
 * 同时支持 Node (同步) 和 Electron 渲染进程 (异步) 模式
 */

import { existsSync, statSync } from "node:fs";
import { parseEventsIncremental, parseEventsIncrementalAsync, type AnyEvent } from "./events-parser";

type EventHandler = (events: AnyEvent[]) => void;

export class EventWatcher {
  private filePath: string;
  private lastOffset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private handlers: EventHandler[] = [];
  private intervalMs: number;
  private useAsync: boolean;

  constructor(filePath: string, intervalMs = 500) {
    this.filePath = filePath;
    this.intervalMs = intervalMs;
    this.useAsync = typeof window !== "undefined"; // 浏览器/Electron 渲染进程用异步

    try {
      if (existsSync(filePath)) {
        this.lastOffset = statSync(filePath).size;
      }
    } catch {
      // 渲染进程中 existsSync 不可用, 偏移从 0 开始
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((h) => h !== h); };
  }

  async poll(): Promise<void> {
    try {
      if (this.useAsync) {
        const { events, newOffset } = await parseEventsIncrementalAsync(this.filePath, this.lastOffset);
        this.lastOffset = newOffset;
        if (events.length > 0) for (const h of this.handlers) h(events);
      } else {
        const { events, newOffset } = parseEventsIncremental(this.filePath, this.lastOffset);
        this.lastOffset = newOffset;
        if (events.length > 0) for (const h of this.handlers) h(events);
      }
    } catch {}
  }

  getOffset(): number { return this.lastOffset; }
}
