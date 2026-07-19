import { Editor } from "@earendil-works/pi-tui";

interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	autocompleteProvider?: unknown;
	autocompleteState?: unknown;
	isInSlashCommandContext(text: string): boolean;
	tryTriggerAutocomplete(explicitTab?: boolean): void;
	handleSlashCommandCompletion(): void;
	insertCharacter(char: string): void;
}

const PATCH_MARK = Symbol.for("agentflux.slash-argument-autocomplete");

export function isSlashArgumentBoundary(textBeforeCursor: string, inserted: string): boolean {
	return /\s/.test(inserted)
		&& textBeforeCursor.startsWith("/")
		&& textBeforeCursor.indexOf(" ") > 1;
}

export function shouldContinueSlashCompletion(textBeforeCursor: string, key: string): boolean {
	return key === "\t" && textBeforeCursor.startsWith("/") && !/\s$/.test(textBeforeCursor);
}

/**
 * pi-tui 0.80 does not request slash-command argument completions after a
 * whitespace character, and routes Tab to file completion once arguments
 * exist. Patch those two editor transitions until the host exposes them as a
 * public autocomplete option.
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
}
