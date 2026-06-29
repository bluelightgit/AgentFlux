/**
 * D1-2: 数据源配置
 * 自动发现 AgentFlux 项目根目录和 events.jsonl 路径
 * 支持同步 (Node) 和异步 (Electron 渲染进程) 两种模式
 */

import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { pathExists } from "./file-access";

export interface ProjectConfig {
  projectRoot: string;
  fluxDir: string;
  eventsPath: string;
  configPath: string;
  projectName: string;
}

// 已验证的项目路径缓存
let cachedProject: ProjectConfig | null = null;

/** 从当前环境推断 AgentFlux 项目 (同步版本, Node 环境) */
export function discoverProject(fallbackPath?: string): ProjectConfig | null {
  if (cachedProject) return cachedProject;

  const candidates = [
    fallbackPath,
    process.env.AGENTFLUX_PROJECT_ROOT,
    "E:/agent-projects/AgentFlux",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const fluxDir = join(candidate, ".agentflux");
    if (existsSync(fluxDir)) {
      cachedProject = {
        projectRoot: candidate,
        fluxDir,
        eventsPath: join(fluxDir, "events.jsonl"),
        configPath: join(fluxDir, "agentflux.json"),
        projectName: basename(candidate),
      };
      return cachedProject;
    }
  }

  // 在 Electron 渲染进程中, existsSync 可能不可用
  // 返回默认路径, 由 init() 中的异步检查验证
  const defaultPath = fallbackPath ?? process.env.AGENTFLUX_PROJECT_ROOT ?? "E:/agent-projects/AgentFlux";
  cachedProject = {
    projectRoot: defaultPath,
    fluxDir: join(defaultPath, ".agentflux"),
    eventsPath: join(defaultPath, ".agentflux", "events.jsonl"),
    configPath: join(defaultPath, ".agentflux", "agentflux.json"),
    projectName: basename(defaultPath),
  };
  return cachedProject;
}

/** 异步验证项目路径是否存在 (Electron 渲染进程) */
export async function validateProjectPath(projectRoot: string): Promise<ProjectConfig | null> {
  const fluxDir = join(projectRoot, ".agentflux");
  const exists = await pathExists(fluxDir);
  if (!exists) return null;

  const config: ProjectConfig = {
    projectRoot,
    fluxDir,
    eventsPath: join(fluxDir, "events.jsonl"),
    configPath: join(fluxDir, "agentflux.json"),
    projectName: basename(projectRoot),
  };
  cachedProject = config;
  return config;
}
