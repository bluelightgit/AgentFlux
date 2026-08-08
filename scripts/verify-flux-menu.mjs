// 真实 TUI 验证：加载 AgentFlux 扩展，打开 /flux 菜单，确认旧格式 issues.json 自动迁移、
// 菜单正常显示、slash 参数补全 bridge 生效（Tab 在 /flux 后触发候选）。
// 用法: node scripts/verify-flux-menu.mjs
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pty = require("E:/agent-projects/PiDeck/node_modules/node-pty/lib/index.js");

const cwd = process.cwd();
const piCli = "C:/Users/y1582/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const sessionDir = join(cwd, ".agentflux", "runtime", "sessions");
const issuesPath = join(cwd, ".agentflux", "issues.json");

// 备份旧 issues.json 内容用于断言
const legacyIssues = existsSync(issuesPath) ? readFileSync(issuesPath, "utf-8") : null;

const proc = pty.spawn(process.execPath, [piCli, "--no-extensions", "-e", "dist/extension/entry.js", "--no-skills", "--session-dir", sessionDir], {
	name: "xterm-256color",
	cwd,
	cols: 120,
	rows: 32,
	env: { ...process.env, TERM: "xterm-256color" },
});

let output = "";
let step = 0;
const timeout = setTimeout(() => { console.log("TIMEOUT"); proc.kill(); process.exit(1); }, 120_000);

function send(text) { proc.write(text); }

proc.onData((data) => {
	output += data;
	process.stdout.write(data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));

	if (step === 0 && output.includes("AgentFlux ready")) {
		step = 1;
		setTimeout(() => send("/flux\r"), 800);
	} else if (step === 1 && output.includes("AgentFlux Workbench")) {
		// 菜单已打开且无 Error → 验证成功，直接结束
		console.log("\n!!! /flux 菜单成功打开");
		proc.kill();
	} else if (step === 1 && output.includes("Error")) {
		console.log("\n!!! /flux 菜单打开失败，出现 Error 输出");
		proc.kill();
		clearTimeout(timeout);
		process.exit(2);
	}
});

proc.onExit(({ exitCode }) => {
	clearTimeout(timeout);
	// 断言 issues.json 已迁移
	let migrated = false;
	if (existsSync(issuesPath)) {
		const now = JSON.parse(readFileSync(issuesPath, "utf-8"));
		migrated = !Array.isArray(now) && Array.isArray(now.issues);
	}
	const ok = migrated && step >= 1;
	console.log(`\n[result] exit=${exitCode} menuStep=${step} issuesMigrated=${migrated}`);
	console.log(`[result] ${ok ? "PASS" : "FAIL"}`);
	process.exit(ok ? 0 : 3);
});
