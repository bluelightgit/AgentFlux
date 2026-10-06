import { TextDecoder, TextEncoder } from "node:util";

export interface JsonlFrame {
	sequence: number;
	text: string;
}

export type JsonlStreamIssueKind =
	| "invalid_utf8"
	| "invalid_json"
	| "invalid_record"
	| "empty_frame"
	| "truncated_frame"
	| "parser_closed"
	| "consumer_error";

export interface JsonlStreamIssue {
	kind: JsonlStreamIssueKind;
	message: string;
	sequence?: number;
	/** True when the stream ended before a complete, trustworthy record existed. */
	incomplete: boolean;
	/** A bounded copy of the offending frame, never the whole stream. */
	truncatedText?: string;
}

export type JsonlFramerItem =
	| { kind: "frame"; frame: JsonlFrame }
	| { kind: "error"; error: JsonlStreamIssue };

export type JsonlParserItem<T> =
	| { kind: "record"; record: T; frame: JsonlFrame }
	| { kind: "error"; error: JsonlStreamIssue };

export interface IncrementalJsonlOptions {
	/** Require each complete frame to contain a JSON object (the Pi event wire shape). */
	requireObject?: boolean;
	/** Bound retained diagnostic text; framing itself remains incremental. */
	maxDiagnosticChars?: number;
}

const DEFAULT_DIAGNOSTIC_CHARS = 512;

function bounded(value: string, max: number): string | undefined {
	if (!value) return undefined;
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

function asBytes(chunk: Uint8Array | ArrayBuffer | string): Uint8Array | string {
	if (typeof chunk === "string") return chunk;
	if (chunk instanceof Uint8Array) return chunk;
	return new Uint8Array(chunk);
}

/**
 * Incremental UTF-8 decoder plus strict LF-only framing.
 *
 * It emits only records that ended with LF. `finish()` reports a non-empty
 * suffix as truncated and deliberately does not parse it. U+2028/U+2029 are
 * ordinary JSON characters and never become record boundaries.
 */
export class IncrementalUtf8LfFramer {
	private decoder = new TextDecoder("utf-8", { fatal: true });
	private buffer = "";
	private sequence = 0;
	private closed = false;
	private readonly maxDiagnosticChars: number;
	private readonly issues: JsonlStreamIssue[] = [];

	constructor(options: Pick<IncrementalJsonlOptions, "maxDiagnosticChars"> = {}) {
		this.maxDiagnosticChars = Math.max(32, options.maxDiagnosticChars ?? DEFAULT_DIAGNOSTIC_CHARS);
	}

	get incomplete(): boolean {
		return this.issues.some(issue => issue.incomplete);
	}

	get errors(): readonly JsonlStreamIssue[] {
		return [...this.issues];
	}

	private issue(kind: JsonlStreamIssueKind, message: string, incomplete: boolean, text?: string): JsonlFramerItem {
		const error: JsonlStreamIssue = {
			kind,
			message,
			incomplete,
			truncatedText: bounded(text ?? "", this.maxDiagnosticChars),
		};
		this.issues.push(error);
		return { kind: "error", error };
	}

	private decode(chunk: Uint8Array | ArrayBuffer | string, stream: boolean): JsonlFramerItem[] {
		if (typeof chunk === "string") {
			this.buffer += chunk;
			return [];
		}
		try {
			const decoded = this.decoder.decode(asBytes(chunk) as Uint8Array, { stream });
			this.buffer += decoded;
			return [];
		} catch (error) {
			// A fatal decoder is important: replacement characters must never turn
			// untrusted bytes into a seemingly valid protocol record. Continue with
			// a non-fatal decoder only to reach the next LF and retain diagnostics.
			const issue = this.issue(
				"invalid_utf8",
				`Invalid UTF-8 in Pi JSONL stream: ${error instanceof Error ? error.message : String(error)}`,
				true,
			);
			this.decoder = new TextDecoder("utf-8", { fatal: false });
			try {
				this.buffer += this.decoder.decode(asBytes(chunk) as Uint8Array, { stream });
			} catch {
				// The fallback decoder is specified not to throw; keep the issue if a
				// host implementation nevertheless does so.
			}
			return [issue];
		}
	}

	private emitFrames(): JsonlFramerItem[] {
		const result: JsonlFramerItem[] = [];
		while (true) {
			const lf = this.buffer.indexOf("\n");
			if (lf < 0) break;
			let text = this.buffer.slice(0, lf);
			this.buffer = this.buffer.slice(lf + 1);
			if (text.endsWith("\r")) text = text.slice(0, -1);
			this.sequence += 1;
			if (text.trim().length === 0) {
				result.push(this.issue("empty_frame", `Pi JSONL frame ${this.sequence} is empty`, true, text));
				continue;
			}
			result.push({ kind: "frame", frame: { sequence: this.sequence, text } });
		}
		return result;
	}

	push(chunk: Uint8Array | ArrayBuffer | string): JsonlFramerItem[] {
		if (this.closed) {
			return [this.issue("parser_closed", "Pi JSONL stream received data after EOF", true)];
		}
		const result = this.decode(chunk, true);
		result.push(...this.emitFrames());
		return result;
	}

	finish(): JsonlFramerItem[] {
		if (this.closed) return [];
		this.closed = true;
		const result: JsonlFramerItem[] = [];
		try {
			this.buffer += this.decoder.decode();
		} catch (error) {
			result.push(this.issue(
				"invalid_utf8",
				`Incomplete UTF-8 sequence at Pi JSONL EOF: ${error instanceof Error ? error.message : String(error)}`,
				true,
			));
		}
		// A final decoder flush cannot create a complete LF frame by itself, and
		// this path intentionally does not parse a suffix without LF.
		if (this.buffer.length > 0) {
			result.push(this.issue(
				"truncated_frame",
				"Pi JSONL stream ended with an unterminated frame; suffix was not parsed",
				true,
				this.buffer,
			));
			this.buffer = "";
		}
		return result;
	}

	/** Alias for stream consumers that call EOF finalization `end`. */
	end(): JsonlFramerItem[] { return this.finish(); }
	flush(): JsonlFramerItem[] { return this.finish(); }
}

export type IncrementalUtf8JsonlFramerOptions = IncrementalJsonlOptions;

/** JSON layer kept separate from byte decoding and framing. */
export class IncrementalJsonlParser<T = Record<string, unknown>> {
	private readonly framer: IncrementalUtf8LfFramer;
	private readonly requireObject: boolean;
	private readonly maxDiagnosticChars: number;
	private readonly issues: JsonlStreamIssue[] = [];
	private closed = false;

	constructor(options: IncrementalJsonlOptions = {}) {
		this.requireObject = options.requireObject !== false;
		this.maxDiagnosticChars = Math.max(32, options.maxDiagnosticChars ?? DEFAULT_DIAGNOSTIC_CHARS);
		this.framer = new IncrementalUtf8LfFramer(options);
	}

	get incomplete(): boolean {
		return this.framer.incomplete || this.issues.some(issue => issue.incomplete);
	}

	get errors(): readonly JsonlStreamIssue[] {
		return [...this.framer.errors, ...this.issues];
	}

	private issue(
		kind: JsonlStreamIssueKind,
		message: string,
		incomplete: boolean,
		sequence?: number,
		text?: string,
	): JsonlParserItem<T> {
		const error: JsonlStreamIssue = {
			kind,
			message,
			sequence,
			incomplete,
			truncatedText: bounded(text ?? "", this.maxDiagnosticChars),
		};
		this.issues.push(error);
		return { kind: "error", error };
	}

	private parse(items: JsonlFramerItem[]): JsonlParserItem<T>[] {
		const result: JsonlParserItem<T>[] = [];
		for (const item of items) {
			if (item.kind === "error") {
				result.push(item);
				continue;
			}
			let value: unknown;
			try {
				value = JSON.parse(item.frame.text);
			} catch (error) {
				result.push(this.issue(
					"invalid_json",
					`Invalid JSON in Pi JSONL frame ${item.frame.sequence}: ${error instanceof Error ? error.message : String(error)}`,
					true,
					item.frame.sequence,
					item.frame.text,
				));
				continue;
			}
			if (this.requireObject && (value === null || typeof value !== "object" || Array.isArray(value))) {
				result.push(this.issue(
					"invalid_record",
					`Pi JSONL frame ${item.frame.sequence} is not a JSON object`,
					true,
					item.frame.sequence,
					item.frame.text,
				));
				continue;
			}
			result.push({ kind: "record", record: value as T, frame: item.frame });
		}
		return result;
	}

	push(chunk: Uint8Array | ArrayBuffer | string): JsonlParserItem<T>[] {
		if (this.closed) {
			return [this.issue("parser_closed", "Pi JSONL parser received data after EOF", true)];
		}
		return this.parse(this.framer.push(chunk));
	}

	finish(): JsonlParserItem<T>[] {
		if (this.closed) return [];
		this.closed = true;
		return this.parse(this.framer.finish());
	}

	end(): JsonlParserItem<T>[] { return this.finish(); }
	flush(): JsonlParserItem<T>[] { return this.finish(); }
}

/** Friendly aliases for callers that use parser/framer terminology. */
export const Utf8LfFramer = IncrementalUtf8LfFramer;
export const Utf8JsonlFramer = IncrementalUtf8LfFramer;
export const JsonlStreamParser = IncrementalJsonlParser;
export const IncrementalUtf8JsonlParser = IncrementalJsonlParser;

export function createJsonlStreamParser<T = Record<string, unknown>>(options: IncrementalJsonlOptions = {}): IncrementalJsonlParser<T> {
	return new IncrementalJsonlParser<T>(options);
}
export const createIncrementalJsonlParser = createJsonlStreamParser;

/**
 * Convert one complete Pi usage snapshot into non-negative scalar counters.
 * This is deliberately not a pricing/charge adapter: it only supports the
 * runner's provisional online snapshot and leaves final accounting to Core.
 */
export interface JsonlUsageCounters {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	contextTokens: number;
	cost: number;
}

function nonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function usageCountersFromJson(value: unknown, costTotal?: (usage: Record<string, unknown>) => number): JsonlUsageCounters {
	const usage = value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
	const rawCost = usage.cost;
	const rawCostObject = rawCost !== null && typeof rawCost === "object" && !Array.isArray(rawCost)
		? rawCost as Record<string, unknown> : undefined;
	const nativeTotal = rawCostObject?.total;
	const cost = typeof rawCost === "number"
		? nonNegativeNumber(rawCost)
		: nativeTotal !== undefined
			? nonNegativeNumber(nativeTotal)
			: costTotal?.(usage) ?? 0;
	return {
		input: nonNegativeNumber(usage.input),
		output: nonNegativeNumber(usage.output),
		cacheRead: nonNegativeNumber(usage.cacheRead),
		cacheWrite: nonNegativeNumber(usage.cacheWrite),
		contextTokens: Math.max(nonNegativeNumber(usage.totalTokens), nonNegativeNumber(usage.contextTokens)),
		cost,
	};
}

export function addJsonlUsage(a: JsonlUsageCounters, b: JsonlUsageCounters): JsonlUsageCounters {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		contextTokens: Math.max(a.contextTokens, b.contextTokens),
		cost: a.cost + b.cost,
	};
}

// Keep TextEncoder referenced for environments whose TS lib does not expose a
// global constructor; string chunks are still handled without re-encoding.
export const utf8Encoder = new TextEncoder();