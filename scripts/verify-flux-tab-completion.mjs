// 真实 TUI 验证 slash 参数补全的“不打扰”行为（2026-08-08 起）：
//  A. '/flux work '（尾随空格）→ 不弹出候选列表（建议文本不再长时间占据输入框区域）
//  B. '/flux work d'（输入参数中）→ 候选列表出现（打字中提示保留）
//  C. 扩展注册的 /flux 命令与 getArgumentCompletions 生效（B 依赖它）
//
// 背景：pi 0.84.1 以 jiti 加载扩展 bundle 时，bundle 内 import 的 pi-tui
// Editor 解析到项目 node_modules 副本，与主进程渲染类不同（双实例），
// bridge 的 prototype patch 无法作用到主进程 Editor；因此列表位置与
// 生命周期由主进程控制。AgentFlux 侧通过 getArgumentCompletions 在
// “当前参数为空（尾随空格）”时返回 null 关闭列表，仅在输入中提示。
//
// 用法: node scripts/verify-flux-tab-completion.mjs
// 依赖: PiDeck 的 node-pty（Windows 上 ESM 需 createRequire 加载）
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pty = require("E:/agent-projects/PiDeck/node_modules/node-pty/lib/index.js");

const cwd = "E:/agent-projects/AgentFlux";
const piCli = "C:/Users/y1582/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const sessionDir = join(cwd, ".agentflux", "runtime", "sessions");

const proc = pty.spawn(process.execPath, [piCli, "--no-extensions", "--no-skills", "--session-dir", sessionDir, "-e", "dist/extension/entry.js"], {
	name: "xterm-256color", cwd, cols: 120, rows: 32,
	env: { ...process.env, TERM: "xterm-256color" },
});

let output = "";
let step = 0;
const timeout = setTimeout(() => { console.log("TIMEOUT step=" + step); proc.kill(); process.exit(1); }, 90_000);

function send(text) { proc.write(text); }
function stripAnsi(t) { return t.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, ""); }

// A 阶段快照：空格后输入行下方不应出现候选（direct/team 等行）
function snapshotA() {
	const clean = stripAnsi(output.slice(-32768));
	const lines = clean.split("\r\n").filter(l => l.trim().length > 0);
	const hasCandidate = lines.some(l => l.includes("direct") && l.includes("基础能力"));
	console.log(`[A] after '/flux work ' candidateListVisible=${hasCandidate}`);
	return hasCandidate;
}
// B 阶段快照：输入 'd' 后候选应出现
function snapshotB() {
	const clean = stripAnsi(output.slice(-32768));
	const lines = clean.split("\r\n").filter(l => l.trim().length > 0);
	const hasCandidate = lines.some(l => l.includes("direct") && l.includes("基础能力"));
	console.log(`[B] after '/flux work d' candidateListVisible=${hasCandidate}`);
	return hasCandidate;
}

proc.onData((data) => {
	output += data;
	const clean = stripAnsi(output);
	if (step === 0 && clean.includes("AgentFlux ready")) {
		step = 1;
		setTimeout(() => send("/flux work "), 1200); // A：空格后不应弹列表
	} else if (step === 1 && clean.includes("/flux work ")) {
		step = 2;
		setTimeout(() => {
			// 全量重绘抓屏（差分渲染下尾部输出不可靠）
			proc.resize(119, 31);
			setTimeout(() => {
				proc.resize(120, 32);
				setTimeout(() => {
					const okA = !snapshotA();
					step = 3;
					send("d"); // B：打字中应弹列表
					setTimeout(() => {
						proc.resize(119, 31);
						setTimeout(() => {
							proc.resize(120, 32);
							setTimeout(() => {
								const okB = snapshotB();
								console.log(`[result] ${okA && okB ? "SLASH_COMPLETION_NON_INTRUSIVE_OK" : "FAILED"}`);
								proc.kill();
							}, 1300);
						}, 1200);
					}, 500);
				}, 1300);
			}, 1200);
		}, 1500);
	}
});

proc.onExit(() => { clearTimeout(timeout); process.exit(0); });
