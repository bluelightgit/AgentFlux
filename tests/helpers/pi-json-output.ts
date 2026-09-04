/**
 * 解析 pi --mode json 输出中的最终 assistant 消息。
 *
 * JSONL 同时包含 user prompt、tool call/result 和 agent_end transcript；
 * 验收 marker 不能在原始 stdout 上做 includes，否则 prompt 回显会造成假阳性。
 */

export function parseJsonLines(output: string): any[] {
	return output.split(/\r?\n/).flatMap(line => {
		if (!line.trim()) return [];
		try { return [JSON.parse(line)]; } catch { return []; }
	});
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block: any) => block && block.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("");
}

function assistantMessageText(message: any): string | undefined {
	if (!message || message.role !== "assistant") return undefined;
	return textFromContent(message.content);
}

/** 返回按 JSONL 事件顺序观察到的 assistant 消息文本。 */
export function assistantMessageTexts(output: string): string[] {
	const messages: string[] = [];
	for (const event of parseJsonLines(output)) {
		if (event.type === "message_end") {
			const text = assistantMessageText(event.message);
			if (text !== undefined) messages.push(text);
		}
		// agent_end 也保留最终 transcript；某些 pi 版本可能只输出该结构。
		if (event.type === "agent_end" && Array.isArray(event.messages)) {
			for (const message of event.messages) {
				const text = assistantMessageText(message);
				if (text !== undefined) messages.push(text);
			}
		}
	}
	return messages;
}

/** 读取 stdout/stderr 中最后一条结构化 assistant 消息，而不是任意回显文本。 */
export function assistantFinalText(stdout: string, stderr = ""): string {
	const messages = [...assistantMessageTexts(stdout), ...assistantMessageTexts(stderr)];
	return messages.at(-1) ?? "";
}

/**
 * 终态 marker 使用最终 assistant 正文的 trim 后精确匹配。
 * 不能使用 includes：否定句或模型复述 marker 都不是完成凭证。
 */
export function hasAssistantFinalMarker(stdout: string, stderr: string, marker: string): boolean {
	const expected = marker.trim();
	return expected.length > 0 && assistantFinalText(stdout, stderr).trim() === expected;
}

export interface AssistantOutputEvidence {
	assistantMessageCount: number;
	finalAssistantText: string;
	parseable: boolean;
	expectedMarker?: string;
	markerMatched?: boolean;
	markerMatchRule?: "trimmed-exact";
}

/** 生成可持久化、可独立复核的 assistant 终态判定，不依赖输出 tail。 */
export function assistantOutputEvidence(stdout: string, stderr = "", marker?: string): AssistantOutputEvidence {
	const messages = [...assistantMessageTexts(stdout), ...assistantMessageTexts(stderr)];
	const finalAssistantText = messages.at(-1) ?? "";
	const evidence: AssistantOutputEvidence = {
		assistantMessageCount: messages.length,
		finalAssistantText,
		parseable: messages.length > 0,
	};
	if (marker !== undefined) {
		evidence.expectedMarker = marker;
		evidence.markerMatched = finalAssistantText.trim() === marker.trim() && marker.trim().length > 0;
		evidence.markerMatchRule = "trimmed-exact";
	}
	return evidence;
}

/** 在实时 JSONL 中识别已经开始执行的具体工具调用。 */
export function toolExecutionStarts(output: string, toolName: string): any[] {
	return parseJsonLines(output).filter(event => event?.type === "tool_execution_start" && event.toolName === toolName);
}
