/**
 * 解析 pi --mode json 输出中的最终 assistant 消息。
 *
 * JSONL 同时包含 user prompt、tool call/result 和 agent_end transcript；
 * 验收 marker 不能在原始 stdout 上做 includes，否则 prompt 回显会造成假阳性。
 */

function parseJsonLines(output: string): any[] {
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

/** marker 只有出现在最终 assistant 消息正文中才算通过。 */
export function hasAssistantFinalMarker(stdout: string, stderr: string, marker: string): boolean {
	return assistantFinalText(stdout, stderr).includes(marker);
}

/** 在实时 JSONL 中识别已经开始执行的具体工具调用。 */
export function toolExecutionStarts(output: string, toolName: string): any[] {
	return parseJsonLines(output).filter(event => event?.type === "tool_execution_start" && event.toolName === toolName);
}
