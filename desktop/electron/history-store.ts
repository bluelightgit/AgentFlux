/**
 * History Store — 持久化读写/schema v2/容量管理
 *
 * 职责：
 * - 使用 schema v2 格式持久化 run history 到 JSON 文件
 * - 启动时从磁盘恢复历史记录（PID 清空、在线状态降级为 aborted）
 * - 容量上限管理
 * - 使用 temp + rename 原子写入
 * - diagnostics 暴露存储状态
 */

import * as path from 'path';
import * as fs from 'fs';
import { isWorkStyleSelection, type TaskPriority, type WorkStyleSelection } from '../shared/runtime-contract';
import type { AgentSessionSnapshot, SessionStatus } from './runtime-manager';

// ─── 常量 ───────────────────────────────────────────────────────────────────

const PERSISTENCE_SCHEMA_VERSION = 2;
const DEFAULT_HISTORY_CAP = 100;

// ─── 类型 ───────────────────────────────────────────────────────────────────

export interface RuntimePersistenceFile {
  schemaVersion: 2;
  savedAt: number;
  records: AgentSessionSnapshot[];
}

export interface PersistenceDiagnostics {
  status: 'disabled' | 'missing' | 'ready' | 'corrupt' | 'unsupported';
  message?: string;
  detectedSchemaVersion?: number | string;
}

export interface HistoryStoreDiagnostics {
  persistence: PersistenceDiagnostics;
}

// ─── HistoryStore 类 ────────────────────────────────────────────────────────

export class HistoryStore {
  private historicalRecords: Map<string, AgentSessionSnapshot> = new Map();
  private persistencePath: string | null = null;
  private historyCap = DEFAULT_HISTORY_CAP;
  private persistenceTimer: NodeJS.Timeout | null = null;
  private diagnostics: PersistenceDiagnostics = { status: 'disabled' };

  /**
   * 启用持久化。
   * @param filePath 持久化文件绝对路径
   * @param historyCap 历史记录容量上限 (1-500)
   */
  configure(filePath: string, historyCap = DEFAULT_HISTORY_CAP): void {
    if (!path.isAbsolute(filePath)) throw new Error('runtime persistence path 必须是绝对路径');
    this.persistencePath = filePath;
    this.historyCap = Math.max(1, Math.min(500, Math.floor(historyCap)));
    this.load();
  }

  getDiagnostics(): PersistenceDiagnostics {
    return { ...this.diagnostics };
  }

  /** 返回所有历史记录（只读快照） */
  list(): AgentSessionSnapshot[] {
    return Array.from(this.historicalRecords.values()).map((snapshot) => ({
      ...snapshot,
      retryable: false,
    }));
  }

  /** 判断 runId 是否在历史记录中 */
  has(runId: string): boolean {
    return this.historicalRecords.has(runId);
  }

  /** 获取单条历史记录 */
  get(runId: string): AgentSessionSnapshot | undefined {
    return this.historicalRecords.get(runId);
  }

  /** 关闭持久化，清理 timer */
  shutdown(): void {
    if (this.persistenceTimer) {
      clearTimeout(this.persistenceTimer);
      this.persistenceTimer = null;
    }
  }

  /**
   * 安排一次延迟持久化（合并多次写入请求）。
   * 调用者应在每次状态变更后调用此方法（如果配置了持久化路径）。
   */
  scheduleSave(currentSnapshots: () => AgentSessionSnapshot[]): void {
    if (!this.persistencePath || this.persistenceTimer) return;
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = null;
      this.save(currentSnapshots());
    }, 100);
    this.persistenceTimer.unref?.();
  }

  /**
   * 立即持久化（用于 shutdown 等需要同步写入的场景）。
   */
  saveNow(currentSnapshots: AgentSessionSnapshot[]): void {
    this.save(currentSnapshots);
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────

  private load(): void {
    this.historicalRecords.clear();
    if (!this.persistencePath) {
      this.diagnostics = { status: 'disabled' };
      return;
    }
    if (!fs.existsSync(this.persistencePath)) {
      this.diagnostics = { status: 'missing' };
      return;
    }
    try {
      const raw = fs.readFileSync(this.persistencePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RuntimePersistenceFile>;
      if (parsed.schemaVersion !== PERSISTENCE_SCHEMA_VERSION) {
        this.diagnostics = {
          status: 'unsupported',
          message: `Runtime history schema ${String(parsed.schemaVersion ?? 'unknown')} is not supported; history was ignored safely.`,
          detectedSchemaVersion: typeof parsed.schemaVersion === 'number' || typeof parsed.schemaVersion === 'string'
            ? parsed.schemaVersion
            : 'unknown',
        };
        return;
      }
      if (!Array.isArray(parsed.records)) {
        this.diagnostics = {
          status: 'corrupt', message: 'Runtime history records are invalid; history was ignored safely.',
        };
        return;
      }
      const records = parsed.records
        .filter((item): item is AgentSessionSnapshot => Boolean(item && typeof item.runId === 'string' && typeof item.name === 'string'))
        .sort((a, b) => b.lastActivity - a.lastActivity)
        .slice(0, this.historyCap);
      for (const item of records) {
        this.historicalRecords.set(item.runId, this.normalizeHistoricalRecord(item));
      }
      this.diagnostics = { status: 'ready' };
    } catch (error: unknown) {
      this.diagnostics = {
        status: 'corrupt',
        message: `Runtime history could not be read; history was ignored safely (${error instanceof Error ? error.message : String(error)}).`,
      };
    }
  }

  private save(currentSnapshots: AgentSessionSnapshot[]): void {
    if (!this.persistencePath) return;
    const merged = new Map(this.historicalRecords);
    for (const snapshot of currentSnapshots) {
      merged.set(snapshot.runId, snapshot);
    }
    const records = Array.from(merged.values())
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, this.historyCap)
      .map((item) => ({ ...item, pendingUiRequests: [] }));
    const payload: RuntimePersistenceFile = {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      savedAt: Date.now(),
      records,
    };
    const directory = path.dirname(this.persistencePath);
    const tempPath = `${this.persistencePath}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify(payload), 'utf8');
      fs.renameSync(tempPath, this.persistencePath);
    } catch {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
  }

  private normalizeHistoricalRecord(item: AgentSessionSnapshot): AgentSessionSnapshot {
    const normalized: AgentSessionSnapshot = {
      ...item,
      projectRoot: typeof item.projectRoot === 'string' ? item.projectRoot : '',
      taskId: typeof item.taskId === 'string' ? item.taskId : `legacy-task-${item.runId}`,
      executionId: typeof item.executionId === 'string' ? item.executionId : `legacy-execution-${item.runId}`,
      retryOfRunId: typeof item.retryOfRunId === 'string' ? item.retryOfRunId : null,
      rootRunId: typeof item.rootRunId === 'string' ? item.rootRunId : item.runId,
      retryAttempt: typeof item.retryAttempt === 'number' ? item.retryAttempt : 0,
      taskTitle: typeof item.taskTitle === 'string' ? item.taskTitle : item.name,
      initialPrompt: typeof item.initialPrompt === 'string' ? item.initialPrompt : '',
      priority: ['low', 'normal', 'high', 'critical'].includes(item.priority) ? item.priority : 'normal',
      workStyle: isWorkStyleSelection(item.workStyle) ? item.workStyle : 'agent_decides',
      pid: null,
      status: (['starting', 'running', 'blocked'].includes(item.status) ? 'aborted' : item.status) as SessionStatus,
      events: Array.isArray(item.events) ? item.events.slice(-1000) : [],
      errorCode: typeof item.errorCode === 'string' ? item.errorCode : null,
      retryable: false,
      cliSource: (['env', 'project', 'path'].includes(item.cliSource) ? item.cliSource : 'project') as 'env' | 'project' | 'path',
      cliPath: typeof item.cliPath === 'string' ? item.cliPath : 'legacy/unknown',
      runtimeSource: typeof item.runtimeSource === 'string' ? item.runtimeSource : 'native-cli',
      runtimeExecutable: typeof item.runtimeExecutable === 'string' ? item.runtimeExecutable : 'legacy/unknown',
      runtimeVersion: typeof item.runtimeVersion === 'string' ? item.runtimeVersion : null,
      pendingUiRequests: [],
      historical: true,
    };
    return normalized;
  }
}
