/**
 * dump-request.ts — dump provider payload 结构, 看 anthropic messages 的 system/messages 布局
 * 用法: pi --no-extensions -e experiments/v0-probe/dump-request.ts --provider octopus-anthropic --model deepseek-v4-flash --thinking off -p "记住我叫小明" 2>/dev/null
 * 输出: .agentflux/last-request.json
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", async (event: any, ctx: any) => {
		const dir = join(ctx.cwd, ".agentflux");
		try { mkdirSync(dir, { recursive: true }); } catch { /* */ }
		const p = event.payload as any;
		// 摘要: 不 dump 完整工具定义, 只看 system + messages 结构
		const summary: any = {
			_keys: Object.keys(p),
			system_type: typeof p.system,
			system_preview: typeof p.system === "string"
				? p.system.slice(0, 200)
				: Array.isArray(p.system) ? p.system.map((b: any) => ({ type: b.type, hasCacheControl: !!b.cache_control, len: b.text?.length })) : null,
			messages: (p.messages || []).map((m: any) => ({
				role: m.role,
				content_type: typeof m.content,
				content: typeof m.content === "string"
					? { str_len: m.content.length, preview: m.content.slice(0, 80) }
					: Array.isArray(m.content)
						? m.content.map((b: any) => ({ type: b.type, hasCacheControl: !!b.cache_control, len: b.text?.length ?? b.id?.length }))
						: null,
			})),
			hasCacheControlAnywhere: JSON.stringify(p).includes("cache_control"),
			tools_count: p.tools?.length ?? 0,
		};
		writeFileSync(join(dir, "last-request-summary.json"), JSON.stringify(summary, null, 2));
		// 完整 payload (去掉 tools 大块)
		const full = { ...p, tools: p.tools ? `[${p.tools.length} tools]` : undefined };
		writeFileSync(join(dir, "last-request-full.json"), JSON.stringify(full, null, 2));
		console.error(`[dump] payload keys: ${Object.keys(p).join(",")} | messages: ${p.messages?.length} | cache_control present: ${summary.hasCacheControlAnywhere}`);
	});
}
