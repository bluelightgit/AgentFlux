import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IncrementalJsonlParser, IncrementalUtf8LfFramer } from "../src/core/jsonl-stream";
import { runAgent } from "../src/agents/agent-runner";

let passed = 0;
const check = (condition: unknown, message: string) => {
	assert.ok(condition, message);
	passed++;
};

const parser = new IncrementalJsonlParser<{ type: string; text?: string }>();
const unicodeRecord = JSON.stringify({ type: "unicode", text: "CJK 字符 😀" + "\u2028\u2029" }) + "\n";
const bytes = Buffer.from(unicodeRecord, "utf8");
const splitPoints = [1, 2, 4, 7, Math.floor(bytes.length / 2), bytes.length - 1];
let start = 0;
for (const end of splitPoints) {
	parser.push(bytes.subarray(start, end));
	start = end;
}
const records = parser.push(bytes.subarray(start));
const completed = records.filter(item => item.kind === "record");
check(completed.length === 1 && completed[0].kind === "record" && completed[0].record.text?.includes("😀"), "UTF-8 code points survive arbitrary byte chunking");
check(completed[0].kind === "record" && completed[0].record.text?.includes("\u2028"), "Unicode line separator is not an LF frame boundary");
assert.deepEqual(parser.finish(), [], "complete LF frame has no EOF issue");
passed++;

const bad = new IncrementalJsonlParser();
const badItems = bad.push(Buffer.from("{bad json}\n", "utf8"));
check(badItems.some(item => item.kind === "error" && item.error.kind === "invalid_json" && item.error.incomplete), "bad JSON is surfaced as an incomplete protocol error");
const tail = new IncrementalJsonlParser();
const tailItems = tail.push(Buffer.from('{"type":"tail"}', "utf8"));
check(tailItems.length === 0, "a no-LF fragment is not parsed as a record");
const tailEnd = tail.finish();
check(tailEnd.some(item => item.kind === "error" && item.error.kind === "truncated_frame" && item.error.incomplete), "EOF tail is recorded as incomplete");

const framer = new IncrementalUtf8LfFramer();
const frameItems = framer.push(Buffer.from('{"type":"one"}\r\n', "utf8"));
check(frameItems.some(item => item.kind === "frame" && item.frame.text === '{"type":"one"}'), "optional CR is stripped only before LF");

const root = mkdtempSync(join(tmpdir(), "agentflux-jsonl-runner-"));
try {
	const helper = join(root, "stream-helper.cjs");
	const capture = join(root, "argv.json");
	writeFileSync(helper, `const fs=require('node:fs');
const capture=process.env.AGENTFLUX_TEST_CAPTURE;
if(capture) fs.writeFileSync(capture, JSON.stringify(process.argv.slice(2)));
const update=JSON.stringify({type:'message_update',usage:{input:7,output:1,cacheRead:2,cacheWrite:0,totalTokens:10,cost:{total:0.02}},assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'partial'}})+'\\n';
const end=JSON.stringify({type:'message_end',message:{role:'assistant',model:'fixture-model',stopReason:'stop',usage:{input:9,output:3,cacheRead:2,cacheWrite:1,totalTokens:15,cost:{total:0.03}},content:[{type:'text',text:'最终 😀'}]}})+'\\n';
const bytes=Buffer.from(update+end,'utf8');
process.stdout.write(bytes.subarray(0, Math.floor(bytes.length/3)), ()=>process.stdout.write(bytes.subarray(Math.floor(bytes.length/3), Math.floor(bytes.length*2/3)), ()=>process.stdout.write(bytes.subarray(Math.floor(bytes.length*2/3)) )));
`);
	const agentResult = await runAgent({
		cwd: root,
		sessionId: "jsonl-test",
		prefixLayout: false,
		agent: {
			name: "jsonl-test-agent",
			role: "implementer",
			description: "fixture",
			skills: ["review"],
			tools: ["read"],
			workspace: { roots: [root] },
			systemPrompt: "",
		},
		task: "stream fixture",
		invocationOverride: { command: process.execPath, args: [helper] },
		env: { AGENTFLUX_TEST_CAPTURE: capture },
	});
	check(agentResult.exitCode === 0, `runner accepts complete message_end (${agentResult.errorMessage ?? ""})`);
	check(agentResult.usage.input === 9 && agentResult.usage.output === 3 && agentResult.usage.cost === 0.03, "message_end usage is authoritative over provisional update usage");
	check(agentResult.output.includes("最终 😀"), "authoritative UTF-8 assistant content is retained");
	check(agentResult.protocolErrors?.length === 0 && agentResult.incomplete === false, "complete stream has no protocol incompleteness");
	const argv = JSON.parse(readFileSync(capture, "utf8")) as string[];
	const noSkills = argv.indexOf("--no-skills");
	const explicitSkill = argv.indexOf("--skill");
	check(noSkills >= 0 && explicitSkill > noSkills && argv[explicitSkill + 1] === "review", "skills are discovery-off then explicit allowlist");
	check(argv.includes("--no-extensions") && argv.includes("-e"), "safe subagent entry is independent of prefixLayout");

	const malformedHelper = join(root, "malformed-helper.cjs");
	writeFileSync(malformedHelper, `process.stdout.write('{not-json}\\n');\n`, "utf8");
	const malformed = await runAgent({
		cwd: root, sessionId: "jsonl-bad", prefixLayout: false,
		agent: { name: "jsonl-bad-agent", role: "implementer", description: "fixture", tools: ["read"], systemPrompt: "" },
		task: "malformed stream", invocationOverride: { command: process.execPath, args: [malformedHelper] },
	});
	check(malformed.exitCode !== 0 && malformed.protocolErrors?.some(error => error.includes("invalid_json")), "bad JSON cannot silently produce success");

	const tailHelper = join(root, "tail-helper.cjs");
	writeFileSync(tailHelper, `process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',usage:{input:1,output:1},content:[]}}));\n`, "utf8");
	const tailRun = await runAgent({
		cwd: root, sessionId: "jsonl-tail", prefixLayout: false,
		agent: { name: "jsonl-tail-agent", role: "implementer", description: "fixture", tools: ["read"], systemPrompt: "" },
		task: "truncated stream", invocationOverride: { command: process.execPath, args: [tailHelper] },
	});
	check(tailRun.exitCode !== 0 && tailRun.incomplete === true && tailRun.protocolErrors?.some(error => error.includes("truncated_frame")), "unterminated JSONL tail is incomplete and never parsed");

	const receiptHelper = join(root, "receipt-helper.cjs");
	const receipt = { schemaVersion: 1, generation: 1, outcome: "completed", terminalFailure: false,
		consumed: false, consumedMessageIds: [], settled: false, continueRequested: false };
	writeFileSync(receiptHelper, `const row=(type, extra)=>process.stdout.write(JSON.stringify({type,...extra})+'\\n');
row('agent_start',{});
row('message_end',{message:{role:'assistant',usage:{input:1,output:1,cost:{total:0.01}},content:[]}});
row('entry_appended',{entry:{type:'custom',customType:'agentflux.boundary.receipt',data:${JSON.stringify(receipt)}}});
row('agent_settled',{});
`, "utf8");
	const seenEvents: string[] = [], seenEntries: unknown[] = [];
	const settledWithReceipt = await runAgent({
		cwd: root, sessionId: "jsonl-receipt", prefixLayout: false, requireBoundaryReceipt: true,
		agent: { name: "jsonl-receipt-agent", role: "implementer", description: "fixture", tools: ["read"], systemPrompt: "" },
		task: "receipt stream", invocationOverride: { command: process.execPath, args: [receiptHelper] },
		onEvent: event => { if (typeof (event as any)?.type === "string") seenEvents.push((event as any).type); },
		onEntry: entry => seenEntries.push(entry),
	});
	check(settledWithReceipt.exitCode === 0 && seenEvents.includes("agent_settled") && seenEntries.length === 1, "event and entry hooks observe the valid settle receipt");

	const costHelper = join(root, "cost-helper.cjs");
	writeFileSync(costHelper, `const row=(type,extra)=>process.stdout.write(JSON.stringify({type,...extra})+'\\n');
row('agent_start',{});
row('message_end',{message:{role:'assistant',provider:'p',model:'m',stopReason:'deferred',usage:{input:3,output:1,cost:{total:0.03}},content:[{type:'text',text:'OK'}]}});
row('message_end',{message:{role:'toolResult',toolName:'codemode',toolCallId:'t1',usage:{input:40,cost:{total:0.4}},content:[]}});
row('entry_appended',{entry:{type:'usage',id:'warm-1',kind:'cache_warm',provider:'p',model:'m',usage:{input:30,cost:{total:0.3}}}});
row('entry_appended',{entry:{type:'custom',customType:'agentflux.boundary.receipt',data:${JSON.stringify(receipt)}}});
row('agent_settled',{});
`);
	const fees = await runAgent({ cwd: root, sessionId: "jsonl-fees", prefixLayout: false, requireBoundaryReceipt: true,
		agent: { name: "fees", tools: ["read"], description: "fixture", systemPrompt: "" }, task: "fees",
		invocationOverride: { command: process.execPath, args: [costHelper] } });
	check(fees.exitCode === 0 && Math.abs(fees.usage.cost - 0.73) < 1e-12 && fees.usage.input === 73 && fees.costAccounting?.complete === true, "spawned runner accounts assistant + tool + standalone usage .73");
	const staleReceiptHelper = join(root, "stale-receipt-helper.cjs");
	writeFileSync(staleReceiptHelper, readFileSync(receiptHelper, "utf8") + `process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');`);
	const stale = await runAgent({ cwd: root, sessionId: "stale", prefixLayout: false, requireBoundaryReceipt: true,
		agent: { name: "stale", tools: ["read"], description: "fixture", systemPrompt: "" }, task: "stale boundary",
		invocationOverride: { command: process.execPath, args: [staleReceiptHelper] } });
	check(stale.exitCode !== 0 && stale.incomplete, "a prior generation receipt cannot certify a later settled generation");

	const missingReceiptHelper = join(root, "missing-receipt-helper.cjs");
	writeFileSync(missingReceiptHelper, `process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',usage:{input:1,output:1},content:[]}})+'\\n');
process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
`, "utf8");
	const missingReceipt = await runAgent({
		cwd: root, sessionId: "jsonl-missing-receipt", prefixLayout: false, requireBoundaryReceipt: true,
		agent: { name: "jsonl-missing-receipt-agent", role: "implementer", description: "fixture", tools: ["read"], systemPrompt: "" },
		task: "missing receipt stream", invocationOverride: { command: process.execPath, args: [missingReceiptHelper] },
	});
	check(missingReceipt.exitCode !== 0 && missingReceipt.incomplete === true && missingReceipt.protocolErrors?.some(error => error.includes("settle boundary receipt")), "missing settle receipt cannot succeed");
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log(`${passed} JSONL/runner checks passed`);
