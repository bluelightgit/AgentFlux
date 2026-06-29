/**
 * D1-2: 数据源配置
 * 自动发现 AgentFlux 项目根目录和 events.jsonl 路径
 */

import { existsSync } from "node:fs";
import { join, basename } from "node:path";

export interface ProjectConfig {
  projectRoot: string;
  fluxDir: string;
  eventsPath: string;
  configPath: string;
  projectName: string;
}

/** 从当前窗口路径推断 AgentFlux 项目 */
export function discoverProject(fallbackPath?: string): ProjectConfig | null {
  // 候选路径: 1) 用户指定 2) 环境变量 3) 默认 AgentFlux 项目
  const candidates = [
    fallbackPath,
    process.env.AGENTFLUX_PROJECT_ROOT,
    "E:/agent-projects/AgentFlux",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const fluxDir = join(candidate, ".agentflux");
    const eventsPath = join(fluxDir, "events.jsonl");
    if (existsSync(fluxDir)) {
      return {
        projectRoot: candidate,
        fluxDir,
        eventsPath,
        configPath: join(fluxDir, "agentflux.json"),
        projectName: basename(candidate),
      };
    }
  }
  return null;
}
