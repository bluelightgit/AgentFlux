// 真实 TUI 验证：/flux work 空格后按 Tab。
// 精确检测补全候选 "work direct"/"work team" 等（这些字符串绝不会出现在启动横幅中）。
// 对照组: NATIVE=1 时不加载 AgentFlux 扩展（原生 pi-tui Tab 走文件补全，应无候选）。
// 用法: node scripts/verify-flux-tab-completion.mjs [native]
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pty = require("E:/agent-projects/PiDeck/node_modules/node-pty/lib/index.js");

const native = process.argv.includes("native");
const cwd = "E:/agent-projects/AgentFlux";
const piCli = "C:/Users/y1582/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const sessionDir = join(cwd, ".agentflux", "runtime", "sessions");

const baseArgs = [piCli, "--no-extensions", "--no-skills", "--session-dir", sessionDir];
if (!native) baseArgs.push("-e", "dist/extension/entry.js");
const proc = pty.spawn(process.execPath, baseArgs, {
	name: "xterm-256color", cwd, cols: 120, rows: 32,
	env: { ...process.env, TERM: "xterm-256color" },
});

let output = "";
let step = 0;
const timeout = setTimeout(() => { console.log("TIMEOUT"); proc.kill(); process.exit(1); }, 90_000);

function send(text) { proc.write(text); }

proc.onData((data) => {
	output += data;
	if (step === 0 && output.length > 600) {
		step = 1;
		setTimeout(() => send("/flux work "), 600);
	} else if (step === 1 && output.length > 800) {
		step = 2;
		setTimeout(() => send("\t"), 500); // Tab 触发补全
	} else if (step === 2) {
		step = 3;
		setTimeout(() => { proc.kill(); }, 3000);
	}
});

proc.onExit(() => {
	clearTimeout(timeout);
	const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
	// 精确候选：完整值 "work direct" 等（横幅中不存在该形式）
	const hasWorkDirect = clean.includes("work direct");
	const hasWorkTeam = clean.includes("work team");
	const hasWorkWorkflow = clean.includes("work workflow");
	const hasWorkCommunity = clean.includes("work community");
	const found = hasWorkDirect || hasWorkTeam || hasWorkWorkflow || hasWorkCommunity;
	console.log(`[result] native=${native} workDirect=${hasWorkDirect} workTeam=${hasWorkTeam} workWorkflow=${hasWorkWorkflow} workCommunity=${hasWorkCommunity}`);
	console.log(`[result] ${found ? "CANDIDATES_FOUND" : "NO_CANDIDATES"}`);
	process.exit(0);
});
