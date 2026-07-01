/**
 * 数据访问层: 通过 Electron preload 暴露的 API 读取文件
 * 在纯浏览器环境降级为空 (无文件系统访问)
 */

declare global {
  interface Window { api?: any }
}

/** 读取文件内容 */
export async function readFileContent(filePath: string): Promise<string> {
  if (typeof window !== "undefined" && window.api?.readFile) {
    return window.api.readFile(filePath);
  }
  return "";
}

/** 获取文件大小 */
export async function getFileSize(filePath: string): Promise<number> {
  if (typeof window !== "undefined" && window.api?.fileSize) {
    return window.api.fileSize(filePath);
  }
  return 0;
}

/** 增量读取文件 */
export async function readFileIncremental(
  filePath: string,
  offset: number,
): Promise<{ content: string; newSize: number }> {
  if (typeof window !== "undefined" && window.api?.ipcRenderer) {
    return await window.api.ipcRenderer.invoke("read-file-incremental", filePath, offset);
  }
  // 降级: 全量读取
  const content = await readFileContent(filePath);
  return { content, newSize: content.length };
}

/** 检查路径是否存在 */
export async function pathExists(filePath: string): Promise<boolean> {
  if (typeof window !== "undefined" && window.api?.exists) {
    return window.api.exists(filePath);
  }
  return false;
}

/** 写入文件内容 (通过 Electron preload bridge 的 write-file IPC 通道) */
export async function writeFileContent(
  filePath: string,
  content: string,
): Promise<boolean> {
  if (typeof window !== "undefined" && window.api?.ipcRenderer) {
    await window.api.ipcRenderer.invoke("write-file", filePath, content);
    return true;
  }
  return false;
}

/** 删除文件 (通过 Electron preload bridge 的 deleteFile 方法) */
export async function deleteFile(filePath: string): Promise<boolean> {
  if (typeof window !== "undefined" && window.api?.deleteFile) {
    return window.api.deleteFile(filePath);
  }
  return false;
}
