/** Host 的 typed chat 元数据投影。只复制元数据，不复制 provider/router 实现或凭据。 */
import type { ModelEntry } from "./model-capability";

export interface HostChatModel {
	id: string;
	provider: string;
	type?: string;
	api?: string;
	contextWindow?: number;
}

export function chatModelKey(provider: string, id: string): string { return `${provider}/${id}`; }

export function buildChatCatalog(
	models: readonly HostChatModel[],
	overlays: Record<string, ModelEntry> = {},
	options: { available?: readonly HostChatModel[]; registeredProviders?: readonly string[] } = {},
): Record<string, ModelEntry> {
	const result: Record<string, ModelEntry> = {};
	const byId = new Map<string, string[]>();
	const available = options.available && new Set(options.available.map(model => chatModelKey(model.provider, model.id)));
	for (const model of models) {
		if (model.type !== undefined && model.type !== "chat") continue;
		if (!model.id || !model.provider) continue;
		const key = chatModelKey(model.provider, model.id);
		const unqualified = overlays[model.id];
		const overlay = overlays[key] ?? (unqualified?.provider === model.provider ? unqualified : undefined);
		result[key] = {
			...overlay,
			id: model.id, provider: model.provider, type: "chat", api: model.api,
			contextWindow: Number.isFinite(model.contextWindow) && model.contextWindow! > 0 ? model.contextWindow : undefined,
			available: available ? available.has(key) : undefined,
			virtual: model.api === "pi-virtual",
			requiresHostRegistration: options.registeredProviders?.includes(model.provider) ?? false,
		};
		byId.set(model.id, [...(byId.get(model.id) ?? []), key]);
	}
	// 保持已知旧 provider 绑定；歧义的裸 ID 不按目录顺序取首个。
	for (const [id, keys] of byId) {
		const pin = overlays[id]?.provider;
		const pinnedKey = pin ? chatModelKey(pin, id) : undefined;
		const key = pinnedKey && result[pinnedKey] ? pinnedKey : keys.length === 1 ? keys[0] : undefined;
		if (key) result[id] = result[key];
	}
	return result;
}

export function resolveChatModel(
	selector: string,
	models: Record<string, ModelEntry>,
	provider?: string,
	options: { physical?: boolean } = {},
): { model: string; provider: string; entry: ModelEntry } {
	const entry = (provider ? models[chatModelKey(provider, selector)] : undefined) ?? models[selector];
	if (!entry) {
		const candidates = [...new Set(Object.values(models).filter(item => item.id === selector).map(item => chatModelKey(item.provider, item.id!)))];
		throw new Error(candidates.length > 1
			? `Ambiguous chat model ${selector}; select provider/model (${candidates.join(", ")})`
			: `Unknown model (chat): ${provider ? `${provider}/` : ""}${selector}`);
	}
	if (entry.type !== undefined && entry.type !== "chat") throw new Error(`Model ${selector} is not a chat model`);
	if (provider && entry.provider !== provider) throw new Error(`Model provider mismatch: ${selector} (${provider} != ${entry.provider})`);
	if (entry.available === false) throw new Error(`Chat model unavailable or authentication unresolved: ${entry.provider}/${entry.id ?? selector}`);
	if (options.physical && (entry.virtual || entry.api === "pi-virtual")) {
		throw new Error(`Virtual model ${selector} cannot be inherited by an isolated child without an approved router; select an explicit physical Agent/role model`);
	}
	if (options.physical && entry.requiresHostRegistration) {
		throw new Error(`Provider ${entry.provider} requires a Host registration not loaded in the isolated child; select a configured physical model`);
	}
	return { model: entry.id ?? selector, provider: entry.provider, entry };
}
