/**
 * cache-inject.ts — AgentFlux prefix layout 核心验证
 *
 * 假设 (docs/06): 主动给历史消息打 cache_control, 可让 L2 (对话历史) 命中缓存。
 * pi 默认只给 system + 最后 user 打 cache_control, 历史不缓存 → L2 命中率为 0。
 *
 * 本扩展在 before_provider_request 给"最后一条历史消息"打 cache_control,
 * 强制把对话历史纳入缓存前缀。与 dump-request (不注入) 对照。
 *
 * 用法:
 *   # 注入组 (本扩展)
 *   pi --no-extensions -e experiments/v0-probe/cache-inject.ts -e experiments/v0-probe/agentflux-probe.ts \
 *     --session-id flux-inject --provider octopus-anthropic --model deepseek-v4-flash --thinking off -p "..."
 *   # 对照组见 dump-request (不注入), 用 --session-id flux-noinject
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", async (event: any, _ctx: any) => {
		const p = event.payload as any;
		const msgs = p.messages;
		if (!Array.isArray(msgs) || msgs.length < 2) return; // 至少要有历史

		// 给"最后一条历史消息" (倒数第二条) 的最后一个 content block 打 cache_control
		// 这样 anthropic 会缓存 [开始 → 倒数第二条] 的全部前缀 (system + 历史)
		const histIdx = msgs.length - 2;
		const hist = msgs[histIdx];
		if (!hist || !Array.isArray(hist.content)) return;

		// 移除历史消息上既有的 cache_control (避免重复断点), 只在最后一个 block 打
		for (const b of hist.content) {
			if (b && b.cache_control) delete b.cache_control;
		}
		const lastBlock = hist.content[hist.content.length - 1];
		if (lastBlock) lastBlock.cache_control = { type: "ephemeral" };

		console.error(`[inject] ${msgs.length} msgs, cache_control 注入到 msg[${histIdx}] (role=${hist.role})`);
		// 返回修改后的 payload
		return p;
	});
}
