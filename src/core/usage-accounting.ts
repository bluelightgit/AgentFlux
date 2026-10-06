import {
	resolveUsageCostDetailed,
	type PricingTable,
	type UsageCostSource,
	type UsageLike,
} from "./pricing";

/** The token counters exposed by the Core usage adapter. */
export interface UsageCounters {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * A deliberately small public snapshot. `complete` means that every accepted
 * charge has a settled, known estimate; it does not mean the estimate is a
 * provider invoice.
 */
export interface UsageAccountingSnapshot extends UsageCounters {
	cost: number;
	turns: number;
	complete: boolean;
	/** True when every accepted charge has a known amount. */
	known: boolean;
	/** Model/provider attribution may be incomplete even when `complete` is true. */
	attributionComplete: boolean;
	/** True while at least one stream charge has not reached message_end/entry. */
	provisional: boolean;
	/** One source when homogeneous, otherwise `mixed`; useful for diagnostics only. */
	costSource: UsageCostSource | "mixed";
}

export interface UsageIdentity {
	provider?: string;
	model?: string;
	responseModel?: string;
	operation?: string;
}

/** A permissive shape shared by Pi messages, session entries, and test fixtures. */
export interface UsageMessageLike extends UsageIdentity {
	role?: string;
	api?: string;
	responseId?: string;
	toolCallId?: string;
	toolName?: string;
	content?: unknown;
	usage?: UsageLike;
	stopReason?: string;
	errorMessage?: string;
	isError?: boolean;
	nestedCalls?: { complete?: boolean };
	attributionComplete?: boolean;
	usageAttributionComplete?: boolean;
	[key: string]: unknown;
}

export interface SessionEntryLike extends UsageIdentity {
	type?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: UsageMessageLike;
	usage?: UsageLike;
	kind?: string;
	fromId?: string | null;
	details?: unknown;
	attributionComplete?: boolean;
	usageAttributionComplete?: boolean;
	[key: string]: unknown;
}

export interface UsageEventOptions extends UsageIdentity {
	sessionId?: string;
	sourceId?: string;
	eventId?: string;
	requestId?: string;
	entryId?: string;
	toolCallId?: string;
	invocationId?: string;
	attributionComplete?: boolean;
	/** A request-level aggregate supplied by the native host. */
	nativeCost?: unknown;
}

export interface UsageAccountingOptions extends UsageIdentity {
	pricing?: PricingTable;
	sessionId?: string;
	/** Existing entries from a fork/resume session. They are context baseline, not new charges. */
	baselineEntryIds?: Iterable<string>;
	/** Alias accepted for callers that already call these IDs a baseline. */
	baselineIds?: Iterable<string>;
	baselineSourceIds?: Iterable<string>;
	baselineEntries?: Iterable<Pick<SessionEntryLike, "id">>;
}

export interface UsageCharge extends UsageIdentity {
	id: string;
	sourceKind: "assistant" | "toolResult" | "usage" | "compaction" | "branch_summary" | "invocation" | "request";
	usage: UsageCounters;
	cost: number;
	costSource: UsageCostSource;
	known: boolean;
	attributionComplete: boolean;
	provisional: boolean;
	settled: boolean;
	turns: number;
	/** Source/event/entry/tool/invocation aliases that resolved to this charge. */
	aliases: string[];
}

interface InternalCharge extends UsageCharge {
	keys: Set<string>;
	fingerprint?: string;
	authority: number;
	sequence: number;
	nativeAggregate: boolean;
}

interface IngestShape {
	kind: InternalCharge["sourceKind"];
	raw: Record<string, unknown>;
	usage: UsageLike;
	usagePresent: boolean;
	options: UsageEventOptions;
	identity: UsageIdentity;
	provisional: boolean;
	authority: number;
	turns: number;
	nativeAggregate: boolean;
	requireUsage: boolean;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function numberOrZero(value: unknown): number {
	return finiteNonNegative(value) ?? 0;
}

function hasOwn(value: UnknownRecord, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function hasUsageShape(value: unknown): value is UsageLike {
	const candidate = asRecord(value);
	if (!candidate) return false;
	return ["input", "output", "cacheRead", "cacheWrite", "cost", "totalTokens", "cacheWrite1h", "reasoning"]
		.some(key => hasOwn(candidate, key));
}

function normalizeUsage(value: unknown): UsageLike {
	const usage = asRecord(value) ?? {};
	const cost = asRecord(usage.cost);
	return {
		input: numberOrZero(usage.input),
		output: numberOrZero(usage.output),
		cacheRead: numberOrZero(usage.cacheRead),
		cacheWrite: numberOrZero(usage.cacheWrite),
		...(finiteNonNegative(usage.cacheWrite1h) !== undefined ? { cacheWrite1h: finiteNonNegative(usage.cacheWrite1h) } : {}),
		...(finiteNonNegative(usage.reasoning) !== undefined ? { reasoning: finiteNonNegative(usage.reasoning) } : {}),
		...(cost ? {
			cost: {
				...(finiteNonNegative(cost.input) !== undefined ? { input: finiteNonNegative(cost.input) } : {}),
				...(finiteNonNegative(cost.output) !== undefined ? { output: finiteNonNegative(cost.output) } : {}),
				...(finiteNonNegative(cost.cacheRead) !== undefined ? { cacheRead: finiteNonNegative(cost.cacheRead) } : {}),
				...(finiteNonNegative(cost.cacheWrite) !== undefined ? { cacheWrite: finiteNonNegative(cost.cacheWrite) } : {}),
				...(finiteNonNegative(cost.total) !== undefined ? { total: finiteNonNegative(cost.total) } : {}),
			},
		} : {}),
	};
}

function counters(usage: UsageLike): UsageCounters {
	return {
		input: numberOrZero(usage.input),
		output: numberOrZero(usage.output),
		cacheRead: numberOrZero(usage.cacheRead),
		cacheWrite: numberOrZero(usage.cacheWrite),
	};
}

function sameText(a: string | undefined, b: string | undefined): boolean {
	return a === undefined || b === undefined || a === b;
}

function stablePart(value: unknown): string {
	if (value === undefined) return "";
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

/**
 * The one Core-side usage adapter. It is intentionally in-memory: callers may
 * persist its snapshot through the existing Task/Run writer, but this class
 * never edits a session file or stores credentials.
 */
export class UsageAccounting {
	private readonly pricing?: PricingTable;
	private readonly sessionId?: string;
	private readonly defaults: UsageIdentity;
	private readonly baselineEntryIds = new Set<string>();
	private readonly baselineSourceIds = new Set<string>();
	private readonly charges = new Map<string, InternalCharge>();
	private readonly keyToCharge = new Map<string, string>();
	private readonly fingerprintToCharges = new Map<string, Set<string>>();
	private sequence = 0;
	private incomplete = false;
	private activeAnonymousStream: string | undefined;

	constructor(options: UsageAccountingOptions = {}) {
		this.pricing = options.pricing;
		this.sessionId = text(options.sessionId);
		this.defaults = {
			provider: text(options.provider),
			model: text(options.model),
			responseModel: text(options.responseModel),
			operation: text(options.operation),
		};
		for (const id of options.baselineEntryIds ?? []) this.addBaselineId(id, this.baselineEntryIds);
		for (const id of options.baselineIds ?? []) this.addBaselineId(id, this.baselineEntryIds);
		for (const id of options.baselineSourceIds ?? []) this.addBaselineId(id, this.baselineSourceIds);
		for (const entry of options.baselineEntries ?? []) if (entry?.id) this.addBaselineId(entry.id, this.baselineEntryIds);
	}

	/** Add a fork/resume baseline before replaying inherited entries. */
	setBaselineEntryIds(ids: Iterable<string>): void {
		for (const id of ids) this.addBaselineId(id, this.baselineEntryIds);
	}

	private addBaselineId(value: unknown, target: Set<string>): void {
		const id = text(value);
		if (!id) return;
		target.add(id);
		target.add(`entry:${id}`);
		target.add(`source:${id}`);
	}

	private isBaseline(options: UsageEventOptions, raw?: UnknownRecord): boolean {
		const candidates = [
			options.entryId,
			options.sourceId,
			options.eventId,
			text(raw?.id),
		].filter((value): value is string => !!value);
		return candidates.some(id => this.baselineEntryIds.has(id) || this.baselineSourceIds.has(id)
			|| this.baselineEntryIds.has(`entry:${id}`) || this.baselineSourceIds.has(`source:${id}`));
	}

	/**
	 * Link a child invocation receipt to the source charge already represented by
	 * a parent tool result. Linking is explicit so equal dollar amounts are never
	 * used as a heuristic for deduplication.
	 */
	aliasInvocation(
		invocation: string | { invocationId: string; sourceId?: string; toolCallId?: string },
		sourceId?: string,
	): void {
		const invocationId = text(typeof invocation === "string" ? invocation : invocation.invocationId);
		const targets = typeof invocation === "string"
			? [sourceId]
			: [invocation.sourceId, invocation.toolCallId];
		if (!invocationId) return;
		const invocationKeys = this.identityVariants("invocation", invocationId);
		for (const targetValue of targets) {
			const target = text(targetValue);
			if (!target) continue;
			this.linkKeys([...invocationKeys, ...this.identityVariants("source", target)]);
			this.linkKeys([...invocationKeys, ...this.identityVariants("tool", target)]);
		}
	}

	registerInvocationAlias(
		invocation: string | { invocationId: string; sourceId?: string; toolCallId?: string },
		sourceId?: string,
	): void {
		this.aliasInvocation(invocation, sourceId);
	}

	addInvocationAlias(
		invocation: string | { invocationId: string; sourceId?: string; toolCallId?: string },
		sourceId?: string,
	): void {
		this.aliasInvocation(invocation, sourceId);
	}

	/** Record a child receipt when the caller has one; aliases keep it one charge. */
	ingestInvocation(
		invocationId: string,
		value: UsageLike | { usage?: UsageLike; costUsd?: number; provider?: string; model?: string; responseModel?: string; operation?: string },
		options: UsageEventOptions = {},
	): UsageAccountingSnapshot {
		const record = asRecord(value) ?? {};
		const usage = hasUsageShape(value) ? value as UsageLike : (record.usage as UsageLike | undefined)
			?? (finiteNonNegative(record.costUsd) !== undefined ? { cost: { total: finiteNonNegative(record.costUsd) } } : {});
		return this.ingestShape({
			kind: "invocation",
			raw: record,
			usage,
			usagePresent: hasUsageShape(usage) || finiteNonNegative(record.costUsd) !== undefined,
			options: { ...options, invocationId },
			identity: this.identityFrom(record, options, "invocation"),
			provisional: false,
			authority: 3,
			turns: 0,
			nativeAggregate: true,
			requireUsage: false,
		});
	}

	/** Ingest an authoritative `message_end` event or its contained message. */
	ingestMessageEnd(value: unknown, options: UsageEventOptions = {}): UsageAccountingSnapshot {
		const event = asRecord(value) ?? {};
		const nestedEvent = asRecord(event.assistantMessageEvent);
		const message = asRecord(event.message)
			?? asRecord(nestedEvent?.message)
			?? (text(event.role) ? event : undefined);
		if (!message) return this.snapshot();
		const mergedOptions = this.mergeEventOptions(event, {
			...options,
			toolCallId: options.toolCallId ?? text(message.toolCallId),
			invocationId: options.invocationId ?? text(message.invocationId),
		});
		const role = text(message.role);
		if (role !== "assistant" && role !== "toolResult") return this.snapshot();
		const operation = text(mergedOptions.operation) ?? text(message.operation) ?? text(message.api);
		const kind = role === "toolResult" ? "toolResult" : operation === "compaction" ? "compaction" : operation === "branch_summary" ? "branch_summary" : "assistant";
		const usageValue = message.usage;
		return this.ingestShape({
			kind,
			raw: message,
			usage: normalizeUsage(usageValue),
			usagePresent: usageValue !== undefined && hasUsageShape(usageValue),
			options: mergedOptions,
			identity: this.identityFrom(message, mergedOptions, kind),
			provisional: false,
			authority: 50,
			turns: kind === "assistant" ? 1 : 0,
			nativeAggregate: kind !== "assistant",
			requireUsage: kind === "assistant" || kind === "compaction" || kind === "branch_summary",
		});
	}

	/** Ingest one Pi session entry without projecting or rewriting it. */
	ingestEntry(value: SessionEntryLike): UsageAccountingSnapshot {
		const entry = asRecord(value) ?? {};
		const type = text(entry.type);
		const message = asRecord(entry.message);
		const entryOptions = this.mergeEventOptions(entry, {
			entryId: text(entry.id),
			sourceId: text(entry.id),
			toolCallId: text(message?.toolCallId),
		});
		if (this.isBaseline(entryOptions, entry)) return this.snapshot();

		if (type === "message") {
			const role = text(message?.role);
			if (role !== "assistant" && role !== "toolResult") return this.snapshot();
			const kind = role === "assistant" ? "assistant" : "toolResult";
			const usageValue = message?.usage;
			return this.ingestShape({
				kind,
				raw: message ?? {},
				usage: normalizeUsage(usageValue),
				usagePresent: usageValue !== undefined && hasUsageShape(usageValue),
				options: entryOptions,
				identity: this.identityFrom(message ?? {}, entryOptions, kind),
				provisional: false,
				authority: 60,
				turns: kind === "assistant" ? 1 : 0,
				nativeAggregate: kind === "toolResult",
				requireUsage: kind === "assistant",
			});
		}

		if (type === "usage") {
			const usageValue = entry.usage;
			if (usageValue === undefined || !hasUsageShape(usageValue)) {
				this.incomplete = true;
				return this.snapshot();
			}
			return this.ingestShape({
				kind: "usage",
				raw: entry,
				usage: normalizeUsage(usageValue),
				usagePresent: true,
				options: entryOptions,
				identity: this.identityFrom(entry, entryOptions, "usage"),
				provisional: false,
				authority: 60,
				turns: 0,
				nativeAggregate: false,
				requireUsage: true,
			});
		}

		if (type === "compaction" || type === "branch_summary") {
			const usageValue = entry.usage;
			if (usageValue === undefined || !hasUsageShape(usageValue)) return this.snapshot();
			return this.ingestShape({
				kind: type,
				raw: entry,
				usage: normalizeUsage(usageValue),
				usagePresent: true,
				options: entryOptions,
				identity: this.identityFrom(entry, entryOptions, type),
				provisional: false,
				authority: 60,
				turns: 0,
				nativeAggregate: true,
				requireUsage: false,
			});
		}

		return this.snapshot();
	}

	/** Ingest a stream update; its usage is a cumulative provisional snapshot. */
	ingestStream(value: unknown, options: UsageEventOptions = {}): UsageAccountingSnapshot {
		const event = asRecord(value) ?? {};
		if (text(event.type) === "message_end") return this.ingestMessageEnd(event, options);
		const nestedEvent = asRecord(event.assistantMessageEvent);
		if ((nestedEvent?.type === "done" || nestedEvent?.type === "error") && asRecord(nestedEvent.message ?? nestedEvent.error)) {
			return this.ingestMessageEnd({ ...event, message: nestedEvent.message ?? nestedEvent.error }, options);
		}
		const message = asRecord(event.partial)
			?? asRecord(nestedEvent?.partial)
			?? asRecord(nestedEvent?.message)
			?? asRecord(event.message)
			?? (text(event.role) ? event : event.type === "message_update" && event.usage ? { role: "assistant", usage: event.usage } : undefined);
		if (!message) return this.snapshot();
		const role = text(message.role);
		if (role !== "assistant" && role !== "toolResult") return this.snapshot();
		const usageValue = message.usage ?? event.usage ?? nestedEvent?.usage;
		if (usageValue === undefined || !hasUsageShape(usageValue)) return this.snapshot();
		const mergedOptions = this.mergeEventOptions(event, {
			...options,
			toolCallId: options.toolCallId ?? text(message.toolCallId),
			invocationId: options.invocationId ?? text(message.invocationId),
		});
		if (!mergedOptions.requestId && !mergedOptions.sourceId && !text(message.responseId)) {
			if (!this.activeAnonymousStream) this.activeAnonymousStream = `anonymous-stream:${++this.sequence}`;
			mergedOptions.sourceId = this.activeAnonymousStream;
		}
		const operation = text(mergedOptions.operation) ?? text(message.operation) ?? text(message.api);
		const kind = role === "toolResult" ? "toolResult" : operation === "compaction" ? "compaction" : operation === "branch_summary" ? "branch_summary" : "assistant";
		return this.ingestShape({
			kind,
			raw: message,
			usage: normalizeUsage(usageValue),
			usagePresent: true,
			options: mergedOptions,
			identity: this.identityFrom(message, mergedOptions, kind),
			provisional: true,
			authority: 10,
			turns: kind === "assistant" ? 1 : 0,
			nativeAggregate: kind !== "assistant",
			requireUsage: true,
		});
	}

	/** Explicit alias for settling a stream with the authoritative message. */
	settleStream(value: unknown, options: UsageEventOptions = {}): UsageAccountingSnapshot {
		const result = this.ingestMessageEnd(value, options);
		this.activeAnonymousStream = undefined;
		return result;
	}

	/** Ingest a session file, an entry-appended event, or a message event. */
	ingest(value: unknown, options: UsageEventOptions = {}): UsageAccountingSnapshot {
		if (Array.isArray(value)) return this.ingestEntries(value as SessionEntryLike[]);
		const record = asRecord(value);
		if (!record) return this.snapshot();
		const type = text(record.type);
		if (type === "message_end") return this.ingestMessageEnd(record, options);
		if (type === "message_update" || type === "message_start" || type === "message_delta") return this.ingestStream(record, options);
		if (type === "entry_appended" && asRecord(record.entry)) return this.ingestEntry(record.entry as SessionEntryLike);
		if (type === "session" || type === "model_change" || type === "thinking_level_change" || type === "custom" || type === "custom_message") return this.snapshot();
		if (type === "request_error" || type === "error" || type === "request_end") return this.ingestRequestFailure(record, options);
		if (type === "message" || type === "usage" || type === "compaction" || type === "branch_summary") return this.ingestEntry(record as SessionEntryLike);
		if (text(record.role)) return this.ingestMessageEnd(record, options);
		if (record.usage !== undefined && hasUsageShape(record.usage)) return this.ingestRequestFailure(record, options);
		return this.snapshot();
	}

	ingestEntries(entries: Iterable<SessionEntryLike>): UsageAccountingSnapshot {
		for (const entry of entries) this.ingest(entry);
		return this.snapshot();
	}

	ingestSession(entries: Iterable<SessionEntryLike> | { entries?: Iterable<SessionEntryLike> }): UsageAccountingSnapshot {
		if (Symbol.iterator in Object(entries)) return this.ingestEntries(entries as Iterable<SessionEntryLike>);
		return this.ingestEntries((entries as { entries?: Iterable<SessionEntryLike> }).entries ?? []);
	}

	/** Keep raw usage from a failed request even when no normal assistant turn follows. */
	private ingestRequestFailure(value: UnknownRecord, options: UsageEventOptions): UsageAccountingSnapshot {
		const usageValue = value.usage ?? value;
		const usagePresent = hasUsageShape(usageValue) || finiteNonNegative(value.costUsd) !== undefined
			|| finiteNonNegative(asRecord(value.cost)?.total) !== undefined;
		if (!usagePresent) {
			this.incomplete = true;
			return this.snapshot();
		}
		const mergedOptions = this.mergeEventOptions(value, {
			...options,
			nativeCost: options.nativeCost ?? value.nativeCost ?? value.costUsd ?? asRecord(value.cost)?.total,
		});
		return this.ingestShape({
			kind: "request",
			raw: value,
			usage: normalizeUsage(usageValue),
			usagePresent: true,
			options: mergedOptions,
			identity: this.identityFrom(value, mergedOptions, "request"),
			provisional: false,
			authority: 50,
			turns: 0,
			nativeAggregate: true,
			requireUsage: false,
		});
	}

	private mergeEventOptions(raw: UnknownRecord, options: UsageEventOptions): UsageEventOptions {
		const nested = asRecord(raw.event) ?? {};
		return {
			...options,
			sessionId: options.sessionId ?? text(raw.sessionId) ?? text(nested.sessionId) ?? this.sessionId,
			sourceId: options.sourceId ?? text(raw.sourceId) ?? text(raw.source) ?? text(nested.sourceId),
			eventId: options.eventId ?? text(raw.eventId) ?? text(raw.id) ?? text(nested.eventId),
			requestId: options.requestId ?? text(raw.requestId) ?? text(raw.request_id) ?? text(nested.requestId),
			entryId: options.entryId ?? text(raw.entryId),
			toolCallId: options.toolCallId ?? text(raw.toolCallId),
			invocationId: options.invocationId ?? text(raw.invocationId),
			provider: options.provider ?? text(raw.provider),
			model: options.model ?? text(raw.model),
			responseModel: options.responseModel ?? text(raw.responseModel),
			operation: options.operation ?? text(raw.operation),
			attributionComplete: options.attributionComplete ?? (typeof raw.attributionComplete === "boolean" ? raw.attributionComplete : undefined),
			nativeCost: options.nativeCost ?? raw.nativeCost,
		};
	}

	private identityFrom(raw: UnknownRecord, options: UsageEventOptions, kind: IngestShape["kind"]): UsageIdentity {
		const allowDefaults = kind === "assistant" || kind === "request";
		const operation = text(raw.operation) ?? text(options.operation)
			?? (kind === "assistant" ? text(raw.api) : undefined)
			?? (kind === "usage" ? text(raw.kind) : undefined)
			?? (kind === "compaction" || kind === "branch_summary" ? kind : undefined)
			?? (kind === "toolResult" ? text(raw.toolName) ?? "tool" : undefined);
		return {
			provider: text(raw.provider) ?? text(options.provider) ?? (allowDefaults ? this.defaults.provider : undefined),
			model: text(raw.model) ?? text(options.model) ?? (allowDefaults ? this.defaults.model : undefined),
			responseModel: text(raw.responseModel) ?? text(options.responseModel) ?? (allowDefaults ? this.defaults.responseModel : undefined),
			operation: operation ?? (allowDefaults ? this.defaults.operation : undefined),
		};
	}

	private ingestShape(shape: IngestShape): UsageAccountingSnapshot {
		if (this.isBaseline(shape.options, shape.raw)) return this.snapshot();
		if (!shape.usagePresent) {
			if (shape.requireUsage) this.incomplete = true;
			return this.snapshot();
		}
		const usage = normalizeUsage(shape.usage);
		const aggregateAttribution = this.inferAttribution(shape);
		const modelForQuote = shape.identity.responseModel ?? shape.identity.model;
		// A heterogeneous/unknown-model tool aggregate has no safe per-token
		// model to quote. Homogeneous tool results and explicitly attributed
		// summary/request entries may still use the remote simple quote when the
		// native total is absent.
		const allowRemoteQuote = !(shape.kind === "toolResult" && !aggregateAttribution);
		const resolution = resolveUsageCostDetailed(usage, modelForQuote, this.pricing, {
			provider: shape.identity.provider,
			nativeCost: shape.options.nativeCost,
			allowRemoteQuote,
		});
		const fingerprint = this.fingerprint(shape.kind, shape.raw, shape.identity, usage);
		const keys = this.buildKeys(shape.kind, shape.options, shape.raw, shape.identity, shape.provisional);
		const incoming: InternalCharge = {
			id: `charge-${++this.sequence}`,
			sourceKind: shape.kind,
			usage: counters(usage),
			cost: resolution.cost,
			costSource: resolution.source,
			known: resolution.known,
			attributionComplete: aggregateAttribution,
			provisional: shape.provisional,
			settled: !shape.provisional,
			turns: shape.turns,
			aliases: [...keys],
			keys: new Set(keys),
			fingerprint,
			authority: shape.authority,
			sequence: this.sequence,
			nativeAggregate: shape.nativeAggregate,
			...shape.identity,
		};
		const existing = this.findExisting(keys, fingerprint, shape);
		if (!existing) {
			this.storeCharge(incoming);
		} else {
			this.updateCharge(existing, incoming);
		}
		return this.snapshot();
	}

	private inferAttribution(shape: IngestShape): boolean {
		const explicit = shape.options.attributionComplete
			?? (typeof shape.raw.attributionComplete === "boolean" ? shape.raw.attributionComplete : undefined)
			?? (typeof shape.raw.usageAttributionComplete === "boolean" ? shape.raw.usageAttributionComplete : undefined);
		if (explicit !== undefined) return explicit;
		const nestedCalls = asRecord(shape.raw.nestedCalls)
			?? asRecord(asRecord(shape.raw.details)?.nestedCalls);
		if (nestedCalls && nestedCalls.complete === false) return false;
		if (shape.kind === "toolResult") return false;
		return !!shape.identity.provider && !!(shape.identity.responseModel ?? shape.identity.model);
	}

	private fingerprint(kind: InternalCharge["sourceKind"], raw: UnknownRecord, identity: UsageIdentity, usage: UsageLike): string {
		return [
			kind,
			identity.provider ?? "",
			identity.model ?? "",
			identity.responseModel ?? "",
			identity.operation ?? "",
			stablePart(raw.role),
			stablePart(raw.toolCallId),
			stablePart(raw.toolName),
			stablePart(raw.stopReason),
			stablePart(raw.content),
			numberOrZero(usage.input), numberOrZero(usage.output), numberOrZero(usage.cacheRead), numberOrZero(usage.cacheWrite),
		].join("|");
	}

	private buildKeys(
		kind: InternalCharge["sourceKind"],
		options: UsageEventOptions,
		raw: UnknownRecord,
		identity: UsageIdentity,
		provisional: boolean,
	): string[] {
		const keys: string[] = [];
		const add = (namespace: string, value: unknown, includeRaw = false): void => {
			const id = text(value);
			if (!id) return;
			keys.push(`${namespace}:${id}`);
			if (includeRaw) keys.push(id);
			if (this.sessionId && namespace !== "entry" && namespace !== "source") keys.push(`session:${this.sessionId}:${namespace}:${id}`);
		};
		add("request", options.requestId);
		add("entry", options.entryId);
		add("source", options.sourceId, true);
		add("tool", options.toolCallId, true);
		add("invocation", options.invocationId, true);
		add("response", text(raw.responseId));
		// Event IDs are useful for authoritative message_end entries. Stream update
		// IDs are transport frames and must not make each cumulative update new cost.
		if (!provisional) add("event", options.eventId);
		if (keys.length === 0 && !provisional && kind === "assistant") {
			const responseId = text(raw.responseId);
			if (responseId) add("response", responseId);
		}
		if (keys.length === 0 && provisional && kind === "assistant" && this.activeAnonymousStream) add("source", this.activeAnonymousStream, true);
		return [...new Set(keys)];
	}

	private findExisting(keys: string[], fingerprint: string, shape: IngestShape): InternalCharge | undefined {
		const candidates = new Set<string>();
		for (const key of keys) {
			const charge = this.chargeForKey(key);
			if (charge) candidates.add(charge.id);
		}
		const fingerprintCharges = this.fingerprintToCharges.get(fingerprint);
		// 仅桥接尚未拥有 entry ID 的 message_end 到它首次追加的 entry。
		// 两条内容/token 相同但 ID 不同的请求，绝不能按内容合并。
		if (candidates.size === 0 && shape.options.entryId && fingerprintCharges) {
			const unbound = [...fingerprintCharges].filter(id => {
				const charge = this.charges.get(id);
				return charge && ![...charge.keys].some(key => key.startsWith("entry:"));
			});
			if (unbound.length === 1) candidates.add(unbound[0]);
		}
		// A stream partial often has no stable response ID. If one matching
		// provisional request exists, settle it instead of creating a second turn.
		if (candidates.size === 0 && !shape.provisional) {
			const provisional = [...this.charges.values()].filter(charge => charge.provisional
				&& charge.sourceKind === shape.kind
				&& sameText(charge.provider, shape.identity.provider)
				&& sameText(charge.model, shape.identity.model));
			if (provisional.length === 1) candidates.add(provisional[0].id);
		}
		let result: InternalCharge | undefined;
		for (const id of candidates) {
			const charge = this.charges.get(id);
			if (!charge) continue;
			if (!result) result = charge;
			else result = this.mergeCharges(result, charge);
		}
		return result;
	}

	private chargeForKey(key: string): InternalCharge | undefined {
		const mapped = this.resolveKey(key);
		return this.charges.get(mapped);
	}

	private resolveKey(key: string): string {
		let current = key;
		const seen = new Set<string>();
		while (this.keyToCharge.has(current) && !seen.has(current)) {
			seen.add(current);
			const next = this.keyToCharge.get(current)!;
			if (next === current) break;
			current = next;
		}
		for (const seenKey of seen) this.keyToCharge.set(seenKey, current);
		return current;
	}

	private storeCharge(charge: InternalCharge): void {
		this.charges.set(charge.id, charge);
		for (const key of charge.keys) this.keyToCharge.set(key, charge.id);
		if (charge.fingerprint) {
			let ids = this.fingerprintToCharges.get(charge.fingerprint);
			if (!ids) this.fingerprintToCharges.set(charge.fingerprint, ids = new Set());
			ids.add(charge.id);
		}
	}

	private updateCharge(existing: InternalCharge, incoming: InternalCharge): void {
		for (const key of incoming.keys) {
			existing.keys.add(key);
			this.keyToCharge.set(key, existing.id);
		}
		for (const alias of incoming.aliases) if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
		existing.provider ??= incoming.provider;
		existing.model ??= incoming.model;
		existing.responseModel ??= incoming.responseModel;
		existing.operation ??= incoming.operation;
		if (incoming.fingerprint) {
			existing.fingerprint ??= incoming.fingerprint;
			let ids = this.fingerprintToCharges.get(incoming.fingerprint);
			if (!ids) this.fingerprintToCharges.set(incoming.fingerprint, ids = new Set());
			ids.add(existing.id);
		}
		if (incoming.provisional && existing.provisional) {
			existing.usage = {
				input: Math.max(existing.usage.input, incoming.usage.input),
				output: Math.max(existing.usage.output, incoming.usage.output),
				cacheRead: Math.max(existing.usage.cacheRead, incoming.usage.cacheRead),
				cacheWrite: Math.max(existing.usage.cacheWrite, incoming.usage.cacheWrite),
			};
			if (incoming.sequence >= existing.sequence) {
				existing.cost = Math.max(existing.cost, incoming.cost);
				existing.costSource = incoming.known || !existing.known ? incoming.costSource : existing.costSource;
				existing.known = existing.known || incoming.known;
				existing.attributionComplete = existing.attributionComplete || incoming.attributionComplete;
			}
			existing.sequence = Math.max(existing.sequence, incoming.sequence);
			return;
		}
		const shouldReplace = !existing.settled
			|| (!incoming.provisional && incoming.authority > existing.authority)
			|| (!existing.known && incoming.known);
		if (shouldReplace) this.replaceCharge(existing, incoming);
	}

	private replaceCharge(target: InternalCharge, source: InternalCharge): void {
		const keys = new Set([...target.keys, ...source.keys]);
		const aliases = [...new Set([...target.aliases, ...source.aliases])];
		const fingerprint = source.fingerprint ?? target.fingerprint;
		Object.assign(target, {
			sourceKind: source.sourceKind,
			usage: source.usage,
			cost: source.cost,
			costSource: source.costSource,
			known: source.known,
			attributionComplete: source.attributionComplete,
			provisional: source.provisional,
			settled: source.settled,
			turns: source.turns,
			provider: source.provider ?? target.provider,
			model: source.model ?? target.model,
			responseModel: source.responseModel ?? target.responseModel,
			operation: source.operation ?? target.operation,
			authority: source.authority,
			sequence: source.sequence,
			nativeAggregate: source.nativeAggregate,
			keys,
			aliases,
			fingerprint,
		});
		for (const key of keys) this.keyToCharge.set(key, target.id);
	}

	private mergeCharges(first: InternalCharge, second: InternalCharge): InternalCharge {
		if (first.id === second.id) return first;
		const firstPreferred = this.preferred(first, second);
		const winner = firstPreferred ? first : second;
		const loser = firstPreferred ? second : first;
		const keys = new Set([...winner.keys, ...loser.keys]);
		const aliases = [...new Set([...winner.aliases, ...loser.aliases])];
		const fingerprint = winner.fingerprint ?? loser.fingerprint;
		winner.keys = keys;
		winner.aliases = aliases;
		winner.fingerprint = fingerprint;
		winner.provider ??= loser.provider;
		winner.model ??= loser.model;
		winner.responseModel ??= loser.responseModel;
		winner.operation ??= loser.operation;
		for (const key of keys) this.keyToCharge.set(key, winner.id);
		this.charges.delete(loser.id);
		for (const ids of this.fingerprintToCharges.values()) {
			if (ids.delete(loser.id)) ids.add(winner.id);
		}
		return winner;
	}

	private preferred(first: InternalCharge, second: InternalCharge): boolean {
		if (first.provisional !== second.provisional) return !first.provisional;
		if (first.known !== second.known) return first.known;
		const firstRank = first.nativeAggregate && first.sourceKind === "toolResult" ? 100 : first.authority;
		const secondRank = second.nativeAggregate && second.sourceKind === "toolResult" ? 100 : second.authority;
		if (firstRank !== secondRank) return firstRank > secondRank;
		if (first.attributionComplete !== second.attributionComplete) return first.attributionComplete;
		return first.sequence <= second.sequence;
	}

	private identityVariants(namespace: string, value: string): string[] {
		return [`${namespace}:${value}`, value];
	}

	private linkKeys(keys: string[]): void {
		const unique = [...new Set(keys.filter(Boolean))];
		if (unique.length < 2) return;
		const charges = new Map<string, InternalCharge>();
		for (const key of unique) {
			const charge = this.chargeForKey(key);
			if (charge) charges.set(charge.id, charge);
		}
		let winner = [...charges.values()][0];
		if (winner) {
			for (const charge of charges.values()) if (charge.id !== winner!.id) winner = this.mergeCharges(winner!, charge);
			for (const key of unique) this.keyToCharge.set(key, winner.id);
		} else {
			const canonical = unique[0];
			for (const key of unique) this.keyToCharge.set(key, canonical);
		}
	}

	/** Return defensive charge records for diagnostics and Core integration. */
	getCharges(): UsageCharge[] {
		return [...this.charges.values()].map(charge => ({
			id: charge.id,
			sourceKind: charge.sourceKind,
			usage: { ...charge.usage },
			cost: charge.cost,
			costSource: charge.costSource,
			known: charge.known,
			attributionComplete: charge.attributionComplete,
			provisional: charge.provisional,
			settled: charge.settled,
			turns: charge.turns,
			aliases: [...charge.aliases],
			provider: charge.provider,
			model: charge.model,
			responseModel: charge.responseModel,
			operation: charge.operation,
		}));
	}

	getSnapshot(): UsageAccountingSnapshot {
		return this.snapshot();
	}

	snapshot(): UsageAccountingSnapshot {
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let cost = 0;
		let turns = 0;
		let known = true;
		let attributionComplete = true;
		let provisional = false;
		const sources = new Set<UsageCostSource>();
		for (const charge of this.charges.values()) {
			input += charge.usage.input;
			output += charge.usage.output;
			cacheRead += charge.usage.cacheRead;
			cacheWrite += charge.usage.cacheWrite;
			cost += charge.cost;
			turns += charge.turns;
			known = known && charge.known;
			attributionComplete = attributionComplete && charge.attributionComplete;
			provisional = provisional || charge.provisional;
			sources.add(charge.costSource);
		}
		const complete = !this.incomplete && !provisional && known;
		return {
			input,
			output,
			cacheRead,
			cacheWrite,
			cost,
			turns,
			complete,
			known,
			attributionComplete,
			provisional,
			costSource: sources.size === 0 ? "unknown" : sources.size === 1 ? [...sources][0] : "mixed",
		};
	}
}

export function createUsageAccounting(options: UsageAccountingOptions = {}): UsageAccounting {
	return new UsageAccounting(options);
}

/** Compatibility name for callers that refer to the adapter rather than its ledger role. */
export const createUsageAccountingAdapter = createUsageAccounting;
