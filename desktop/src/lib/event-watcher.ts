/**
 * D1-6: 实时文件监听 + 增量推送
 * 监听 events.jsonl 变化, 增量解析并通知订阅者
 */

import { parseEventsIncremental, type AnyEvent } from "./events-parser";

type EventHandler = (events: AnyEvent[]) => void;

export class EventWatcher {
  private filePath: string;
  private lastOffset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private handlers: EventHandler[] = [];
  private intervalMs: number;

  constructor(filePath: string, intervalMs = 500) {
    this.filePath = filePath;
    this.intervalMs = intervalMs;
    // Initialize offset to file size (only watch new events)
    try {
      const fs = require("fs");
      if (fs.existsSync(filePath)) {
        this.lastOffset = fs.statSync(filePath).size;
      }
    } catch {}
  }

  /** 开始监听 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  /** 停止监听 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 订阅新事件 */
  onEvent(handler: EventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** 手动触发一次轮询 */
  poll(): void {
    try {
      const { events, newOffset } = parseEventsIncremental(this.filePath, this.lastOffset);
      if (events.length > 0) {
        this.lastOffset = newOffset;
        for (const handler of this.handlers) {
          handler(events);
        }
      } else {
        this.lastOffset = newOffset;
      }
    } catch {}
  }

  /** 获取当前 offset (用于调试) */
  getOffset(): number {
    return this.lastOffset;
  }
}
