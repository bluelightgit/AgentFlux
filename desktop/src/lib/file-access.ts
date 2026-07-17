/**
 * 数据访问层: 通过 Electron preload 暴露的 API 读取文件
 * 在纯浏览器环境降级为空 (无文件系统访问)
 */

/** Typed interface for known Electron file API methods (used internally via cast). */
interface ElectronFileApi {
  readFile: (path: string) => string | Promise<string>;
  fileSize: (path: string) => number | Promise<number>;
  getFileSize: (path: string) => number | Promise<number>;
  exists: (path: string) => boolean | Promise<boolean>;
  deleteFile: (path: string) => boolean | Promise<boolean>;
  listDirectory: (path: string) => string[] | Promise<string[]>;
  readDirectory: (path: string) => string[] | Promise<string[]>;
  readDirectoryFiles: (path: string) => Array<{ name: string; content: string }> | Promise<Array<{ name: string; content: string }>>;
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
}

declare global {
  interface Window {
    /** Electron preload API. Loosely typed for cross-file compatibility. */
    api?: any;
  }
}

/** Local helper: narrow window.api to the typed interface. */
function getApi(): ElectronFileApi | undefined {
  if (typeof window === "undefined") return undefined;
  return window.api as ElectronFileApi | undefined;
}

/** 读取文件内容 */
export async function readFileContent(filePath: string): Promise<string> {
  const api = getApi();
  if (api?.readFile) {
    return api.readFile(filePath);
  }
  return "";
}

/** 获取文件大小 */
export async function getFileSize(filePath: string): Promise<number> {
  const api = getApi();
  if (api?.fileSize) {
    return api.fileSize(filePath);
  }
  return 0;
}

/** 增量读取文件 */
export async function readFileIncremental(
  filePath: string,
  offset: number,
): Promise<{ content: string; newSize: number }> {
  const api = getApi();
  if (api?.ipcRenderer) {
    return await api.ipcRenderer.invoke("read-file-incremental", filePath, offset) as { content: string; newSize: number };
  }
  // 降级: 全量读取
  const content = await readFileContent(filePath);
  return { content, newSize: content.length };
}

/** 检查路径是否存在 */
export async function pathExists(filePath: string): Promise<boolean> {
  const api = getApi();
  if (api?.exists) {
    return api.exists(filePath);
  }
  return false;
}

/** 写入文件内容 (通过 Electron preload bridge 的 write-file IPC 通道) */
export async function writeFileContent(
  filePath: string,
  content: string,
): Promise<boolean> {
  const api = getApi();
  if (api?.ipcRenderer) {
    await api.ipcRenderer.invoke("write-file", filePath, content);
    return true;
  }
  return false;
}

/** 删除文件 (通过 Electron preload bridge 的 deleteFile 方法) */
export async function deleteFile(filePath: string): Promise<boolean> {
  const api = getApi();
  if (api?.deleteFile) {
    return api.deleteFile(filePath);
  }
  return false;
}

// ─── 扩展工具函数 ───────────────────────────────────────────────────────────

/** 确保目录存在（递归创建） */
export async function ensureDir(dirPath: string): Promise<boolean> {
  const api = getApi();
  if (api?.ipcRenderer) {
    // 尝试写入一个空文件来确保目录存在；write-file 内部会创建父目录
    const testFile = `${dirPath.replace(/\\$/,'')}/.mkdir_guard`;
    try {
      await api.ipcRenderer.invoke("write-file", testFile, "");
      if (api.deleteFile) {
        await api.deleteFile(testFile);
      }
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** 写入文件（别名，语义更清晰） */
export async function writeFile(filePath: string, content: string): Promise<void> {
  const ok = await writeFileContent(filePath, content);
  if (!ok) throw new Error(`写入文件失败: ${filePath}`);
}

/** 检查路径是否为目录 */
export async function isDirectory(filePath: string): Promise<boolean> {
  const api = getApi();
  if (api?.ipcRenderer) {
    try {
      const entries = await api.ipcRenderer.invoke("list-directory", filePath) as string[];
      return Array.isArray(entries);
    } catch {
      return false;
    }
  }
  return false;
}

/** 列出目录内容 */
export async function listDirectory(dirPath: string): Promise<string[]> {
  const api = getApi();
  if (api?.listDirectory) {
    return api.listDirectory(dirPath);
  }
  return [];
}

/** 读取目录下所有文件的内容 */
export async function readDirectoryFiles(
  dirPath: string,
): Promise<Array<{ name: string; content: string }>> {
  const api = getApi();
  if (api?.readDirectoryFiles) {
    return api.readDirectoryFiles(dirPath);
  }
  return [];
}
