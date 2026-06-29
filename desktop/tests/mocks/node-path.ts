// Mock for node:path in jsdom environment
export const join = (...parts: string[]): string => parts.join("/").replace(/\/+/g, "/");
export const basename = (p: string): string => p.split("/").pop() ?? p;
export const dirname = (p: string): string => p.split("/").slice(0, -1).join("/") || ".";
export const resolve = (...parts: string[]): string => parts.join("/").replace(/\/+/g, "/");
export const extname = (p: string): string => {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i) : "";
};
