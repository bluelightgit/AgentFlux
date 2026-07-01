/**
 * QuickActions
 * 快捷操作按钮: 重启 / 健康检查 / 压缩上下文 / 强制模式 / 清除覆写
 * 通过向 `${fluxDir}/runtime/override.json` 写入指令实现。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import { writeFileContent, deleteFile } from "../lib/file-access";
import { Card, Icon, Badge } from "./ui";

/** 单个快捷操作的配置。 */
interface QuickAction {
  id: string;
  label: string;
  icon: string;
  /** 执行该操作, 抛出错误时由调用方处理。 */
  run: (overridePath: string) => Promise<void>;
}

/** 操作完成后 "Done!" 徽章的显示时长 (毫秒)。 */
const DONE_BADGE_MS = 2000;

const ACTIONS: QuickAction[] = [
  {
    id: "restart",
    label: "Restart",
    icon: "RefreshCw",
    run: async (p) => {
      await writeFileContent(p, JSON.stringify({ action: "restart" }));
    },
  },
  {
    id: "health",
    label: "Health Check",
    icon: "HeartPulse",
    run: async (p) => {
      await writeFileContent(p, JSON.stringify({ action: "health" }));
    },
  },
  {
    id: "compact",
    label: "Compact Context",
    icon: "Shrink",
    run: async (p) => {
      await writeFileContent(p, JSON.stringify({ action: "compact" }));
    },
  },
  {
    id: "force-m1",
    label: "Force M1 (Eco)",
    icon: "Leaf",
    run: async (p) => {
      await writeFileContent(p, JSON.stringify({ action: "force_mode", mode: "M1" }));
    },
  },
  {
    id: "force-m2",
    label: "Force M2 (Balanced)",
    icon: "Scale",
    run: async (p) => {
      await writeFileContent(p, JSON.stringify({ action: "force_mode", mode: "M2" }));
    },
  },
  {
    id: "clear-override",
    label: "Clear Override",
    icon: "X",
    run: async (p) => {
      await deleteFile(p);
    },
  },
];

export function QuickActions(): React.ReactElement {
  const project = useDashboardStore((s) => s.project);

  // 每个 action 的瞬时状态: idle | done | error
  const [status, setStatus] = useState<Record<string, "done" | "error">>({});
  const [errorMsg, setErrorMsg] = useState<Record<string, string>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  /** 清理所有挂起的计时器。 */
  useEffect(() => {
    return () => {
      for (const t of Object.values(timers.current)) clearTimeout(t);
    };
  }, []);

  const runAction = useCallback(
    async (action: QuickAction) => {
      if (!project?.fluxDir) {
        setStatus((s) => ({ ...s, [action.id]: "error" }));
        setErrorMsg((s) => ({ ...s, [action.id]: "No project loaded" }));
        return;
      }
      const overridePath = `${project.fluxDir}/runtime/override.json`;
      try {
        await action.run(overridePath);
        setStatus((s) => ({ ...s, [action.id]: "done" }));
        setErrorMsg((s) => {
          const next = { ...s };
          delete next[action.id];
          return next;
        });
      } catch (err: any) {
        setStatus((s) => ({ ...s, [action.id]: "error" }));
        setErrorMsg((s) => ({
          ...s,
          [action.id]: err?.message ?? "Failed",
        }));
      }

      // 2 秒后自动清除状态
      if (timers.current[action.id]) clearTimeout(timers.current[action.id]);
      timers.current[action.id] = setTimeout(() => {
        setStatus((s) => {
          const next = { ...s };
          delete next[action.id];
          return next;
        });
        setErrorMsg((s) => {
          const next = { ...s };
          delete next[action.id];
          return next;
        });
        delete timers.current[action.id];
      }, DONE_BADGE_MS);
    },
    [project?.fluxDir],
  );

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Zap" size={18} className="text-amber-500 dark:text-amber-400" />
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
          Quick Actions
        </h2>
      </div>

      {/* Action grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {ACTIONS.map((action) => {
          const st = status[action.id];
          return (
            <div key={action.id} className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => runAction(action)}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
              >
                <Icon name={action.icon} size={16} className="text-slate-500 dark:text-slate-400" />
                <span>{action.label}</span>
              </button>
              {st === "done" ? (
                <div className="flex justify-center">
                  <Badge color="green">Done!</Badge>
                </div>
              ) : st === "error" ? (
                <div className="flex justify-center">
                  <Badge color="red">{errorMsg[action.id] ?? "Error"}</Badge>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
