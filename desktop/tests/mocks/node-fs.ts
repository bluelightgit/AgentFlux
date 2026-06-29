// Mock for node:fs in jsdom environment
export const readFileSync = (_path: string, _enc?: string): string => "";
export const writeFileSync = (_path: string, _data: string): void => {};
export const existsSync = (_path: string): boolean => false;
export const statSync = (_path: string): { size: number } => ({ size: 0 });
export const readdirSync = (_path: string): string[] => [];
export const mkdirSync = (_path: string, _opts?: any): void => {};
export const unlinkSync = (_path: string): void => {};
export const appendFileSync = (_path: string, _data: string): void => {};
