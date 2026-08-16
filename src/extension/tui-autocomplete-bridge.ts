/**
 * slash 命令参数补全的纯判定函数。
 *
 * 说明（2026-08-16 清理）：此前这里的 Editor 原型补丁（候选列表上移、
 * 自动关闭定时器等）对 pi 0.84.1 的真实 TUI 无效——扩展 bundle 内解析到
 * 的 pi-tui Editor 类与主进程 TUI 使用的类是两个物理路径不同的副本，
 * patch 不会作用到主进程实例。真实 TUI 中候选列表行为由主进程控制：
 * 空参数时 getArgumentCompletions 返回 null 以关闭列表（见 commands.ts）。
 * 因此原型补丁已删除，只保留下面两个无副作用的纯判定函数供测试与
 * 未来接线使用。
 */

export function isSlashArgumentBoundary(textBeforeCursor: string, inserted: string): boolean {
	return /\s/.test(inserted)
		&& textBeforeCursor.startsWith("/")
		&& textBeforeCursor.indexOf(" ") > 1;
}

export function shouldContinueSlashCompletion(textBeforeCursor: string, key: string): boolean {
	return key === "\t" && textBeforeCursor.startsWith("/") && !/\s$/.test(textBeforeCursor);
}
