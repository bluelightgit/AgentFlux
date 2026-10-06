/** 控制面 DTO：不要让 JSON.stringify 把 Map/非有限数静默变成空对象/null。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function toJsonValue(value: unknown, seen = new Set<object>()): JsonValue | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Tool details contain a non-finite number");
		return value;
	}
	if (typeof value !== "object") throw new Error("Tool details must be JSON-compatible");
	if (seen.has(value)) throw new Error("Tool details contain a circular reference");
	if (value instanceof Map || value instanceof Set || value instanceof Date || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error("Tool details require an explicit JSON DTO projection");
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map(item => {
			const projected = toJsonValue(item, seen);
			if (projected === undefined) throw new Error("Tool details contain an undefined array element");
			return projected;
		});
		const output: { [key: string]: JsonValue } = {};
		for (const [key, item] of Object.entries(value)) {
			const projected = toJsonValue(item, seen);
			if (projected !== undefined) Object.defineProperty(output, key, { value: projected, enumerable: true, writable: true, configurable: true });
		}
		return output;
	} finally { seen.delete(value); }
}

export function toolDetailsFailed(details: unknown): boolean {
	if (!details || typeof details !== "object") return false;
	const item = details as { ok?: boolean; status?: string };
	return item.ok === false || ["failed", "partial", "cancelled", "timed_out", "budget_exceeded"].includes(item.status ?? "");
}
