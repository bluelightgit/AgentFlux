/**
 * D1-2: 数据源配置
 * 自动发现 AgentFlux 项目根目录和 events.jsonl 路径
 *
 * IMPORTANT: No node:fs or node:path imports — uses simple string
 * operations and async validation via IPC. This allows the module
 * to load safely in the Electron renderer (browser context).
 */

import { pathExists } from "./file-access";

export interface ProjectConfig {
  projectRoot: string;
  fluxDir: string;
  eventsPath: string;
  configPath: string;
  projectName: string;
}

// ─── Path utilities (no node:path dependency) ───

function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

// 已验证的项目路径缓存
let cachedProject: ProjectConfig | null = null;

/**
 * 从当前环境推断 AgentFlux 项目 (同步, 不检查文件存在性)
 * 在 Electron 渲染进程中, 使用此函数获取路径, 然后用
 * validateProjectPath() 异步验证路径是否存在
 */
export function discoverProject(fallbackPath?: string): ProjectConfig | null {
  if (cachedProject) return cachedProject;

  const candidates = [
    fallbackPath,
    (typeof process !== "undefined" && process.env?.AGENTFLUX_PROJECT_ROOT) || undefined,
    "E:/agent-projects/AgentFlux",
  ].filter(Boolean) as string[];

  const projectRoot = candidates[0] || "E:/agent-projects/AgentFlux";
  const fluxDir = joinPath(projectRoot, ".agentflux");

  cachedProject = {
    projectRoot,
    fluxDir,
    eventsPath: joinPath(fluxDir, "events.jsonl"),
    configPath: joinPath(fluxDir, "agentflux.json"),
    projectName: basename(projectRoot),
  };
  return cachedProject;
}

/** 异步验证项目路径是否存在 (Electron 渲染进程) */
export async function validateProjectPath(projectRoot: string): Promise<ProjectConfig | null> {
  const fluxDir = joinPath(projectRoot, ".agentflux");
  const exists = await pathExists(fluxDir);
  if (!exists) return null;

  const config: ProjectConfig = {
    projectRoot,
    fluxDir,
    eventsPath: joinPath(fluxDir, "events.jsonl"),
    configPath: joinPath(fluxDir, "agentflux.json"),
    projectName: basename(projectRoot),
  };
  cachedProject = config;
  return config;
}

/** Exported for testing */
export { joinPath, basename };
