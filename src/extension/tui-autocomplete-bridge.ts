import { Editor } from "@earendil-works/pi-tui";

interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	autocompleteProvider?: unknown;
	autocompleteState?: unknown;
	autocompleteList?: { render(width: number): string[] };
	paddingX?: number;
	tui?: { requestRender(): void };
	isInSlashCommandContext(text: string): boolean;
	tryTriggerAutocomplete(explicitTab?: boolean): void;
	handleSlashCommandCompletion(): void;
	insertCharacter(char: string): void;
	applyAutocompleteSuggestions?(suggestions: unknown, state: string): void;
	cancelAutocomplete?(): void;
	render?(width: number): string[];
	[autoCloseMark]?: ReturnType<typeof setTimeout> | undefined;
}

const PATCH_MARK = Symbol.for("agentflux.slash-argument-autocomplete");
const autoCloseMark = Symbol.for("agentflux.autocomplete-auto-close-timer");

/** 候选列表无操作自动关闭时间（毫秒）。 */
const AUTO_CLOSE_MS = 4_000;

export function isSlashArgumentBoundary(textBeforeCursor: string, inserted: string): boolean {
	return /\s/.test(inserted)
		&& textBeforeCursor.startsWith("/")
		&& textBeforeCursor.indexOf(" ") > 1;
}

export function shouldContinueSlashCompletion(textBeforeCursor: string, key: string): boolean {
	return key === "\t" && textBeforeCursor.startsWith("/") && !/\s$/.test(textBeforeCursor);
}

/**
 * 为 pi-tui 的 Editor 补齐 slash 命令参数补全的两处过渡：
 *  - 输入空格后请求参数补全（0.80 原生不请求）；
 *  - slash 上下文含空格时 Tab 走命令补全而非文件补全。
 *
 * 另加两个候选列表 UX 修正：
 *  - 列表渲染到输入行上方（编辑器顶部）而不是下方，避免建议文本
 *    看起来像输入框内容；
 *  - 列表打开后 AUTO_CLOSE_MS 无操作自动关闭，避免长时间占据屏幕。
 *
 * 注意（2026-08-08 实测）：这些 patch 只对“扩展进程内解析到的 pi-tui
 * Editor 类”生效。pi 0.84.1 以 jiti 加载扩展 bundle 时，bundle 中的
 * `import { Editor } from "@earendil-works/pi-tui"` 解析到扩展所在项目
 * node_modules 的副本，而主进程 TUI 渲染/事件使用 pi-coding-agent 自带
 * 的副本——两者物理路径不同，patch 不会作用到主进程的 Editor 类。
 * 因此真实 TUI 中列表位置与生命周期仍由主进程控制（getArgumentCompletions
 * 空参数返回 null 以关闭列表，见 src/extension/commands.ts）。本函数
 * 的逻辑仍保留并通过单元测试，一旦 pi 的 alias 重定向对 bundle 生效
 * （或 Editor 类统一），这些修正会自动启用。
 */
export function installSlashArgumentAutocompleteBridge(): void {
	const prototype = Editor.prototype as unknown as Record<PropertyKey, any>;
	if (prototype[PATCH_MARK]) return;
	prototype[PATCH_MARK] = true;

	const insertCharacter = prototype.insertCharacter;
	prototype.insertCharacter = function (this: EditorInternals, char: string, ...args: unknown[]) {
		const result = insertCharacter.call(this, char, ...args);
		const line = this.state.lines[this.state.cursorLine] ?? "";
		const textBeforeCursor = line.slice(0, this.state.cursorCol);
		if (this.autocompleteProvider && !this.autocompleteState && isSlashArgumentBoundary(textBeforeCursor, char)) {
			this.tryTriggerAutocomplete();
		}
		return result;
	};

	const handleTabCompletion = prototype.handleTabCompletion;
	prototype.handleTabCompletion = function (this: EditorInternals) {
		const line = this.state.lines[this.state.cursorLine] ?? "";
		const textBeforeCursor = line.slice(0, this.state.cursorCol);
		if (this.isInSlashCommandContext(textBeforeCursor)) {
			this.handleSlashCommandCompletion();
			return;
		}
		return handleTabCompletion.call(this);
	};

	const handleInput = prototype.handleInput;
	prototype.handleInput = function (this: EditorInternals, data: string) {
		const hadAutocomplete = Boolean(this.autocompleteState);
		const result = handleInput.call(this, data);
		const line = this.state.lines[this.state.cursorLine] ?? "";
		const textBeforeCursor = line.slice(0, this.state.cursorCol);
		if (hadAutocomplete && !this.autocompleteState && shouldContinueSlashCompletion(textBeforeCursor, data)) {
			this.insertCharacter(" ");
		}
		return result;
	};

	// 候选列表显示在输入行上方（编辑器顶部），而不是输入框下方。
	// 列表行始终是 render 结果末尾的 N 行，行数由 autocompleteList.render
	// 计算（与 pi-tui 自身相同的 contentWidth 公式），移序后布局总高度不变。
	const render = prototype.render;
	if (typeof render === "function") {
		prototype.render = function (this: EditorInternals, width: number) {
			const result = render.call(this, width) as string[];
			if (this.autocompleteState && this.autocompleteList) {
				try {
					const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
					const paddingX = Math.min(this.paddingX ?? 0, maxPadding);
					const contentWidth = Math.max(1, width - paddingX * 2);
					const listLines = this.autocompleteList.render(contentWidth);
					if (listLines.length > 0 && result.length >= listLines.length) {
						const moved = result.splice(result.length - listLines.length, listLines.length);
						result.unshift(...moved);
					}
				} catch {
					// 布局调整失败时保持 pi-tui 原渲染，不影响输入
				}
			}
			return result;
		};
	}

	// 候选列表打开后无操作自动关闭，避免长时间占据屏幕。
	const applyAutocompleteSuggestions = prototype.applyAutocompleteSuggestions;
	if (typeof applyAutocompleteSuggestions === "function") {
		prototype.applyAutocompleteSuggestions = function (this: EditorInternals, ...args: unknown[]) {
			const result = applyAutocompleteSuggestions.apply(this, args);
			if (this[autoCloseMark]) clearTimeout(this[autoCloseMark]);
			this[autoCloseMark] = setTimeout(() => {
				this[autoCloseMark] = undefined;
				this.cancelAutocomplete?.();
				this.tui?.requestRender();
			}, AUTO_CLOSE_MS);
			return result;
		};
	}

	const cancelAutocomplete = prototype.cancelAutocomplete;
	if (typeof cancelAutocomplete === "function") {
		prototype.cancelAutocomplete = function (this: EditorInternals, ...args: unknown[]) {
			if (this[autoCloseMark]) {
				clearTimeout(this[autoCloseMark]);
				this[autoCloseMark] = undefined;
			}
			return cancelAutocomplete.apply(this, args);
		};
	}
}
