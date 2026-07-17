const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const pidFile = process.argv[2];
if (!pidFile) throw new Error("missing pid file");

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
	stdio: "ignore",
	windowsHide: true,
});
writeFileSync(pidFile, JSON.stringify({ parent: process.pid, child: child.pid }), "utf-8");
setInterval(() => {}, 1000);
