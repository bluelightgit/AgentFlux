import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

// 仅在 AgentFlux 非交互子 Pi 的 CLI 加载前安装；不改变父 Main 或全局环境。
// windowsHide 是 Host 默认创建选项，保留显式 false 的交互意图；不是 GUI/进程隔离。
function hiddenOptions(args, arrayArgs, acceptsCallback) {
	const next = [...args];
	let index = 1;
	if (arrayArgs) {
		const second = next[1];
		if (Array.isArray(second) || second == null) index = 2;
		else if (typeof second !== "object" && !(acceptsCallback && typeof second === "function")) return args;
	}
	const options = next[index];
	if (acceptsCallback && typeof options === "function") next.splice(index, 0, { windowsHide: true });
	else if (options == null) next[index] = { windowsHide: true };
	else if (typeof options === "object" && !Array.isArray(options)) {
		next[index] = { ...options };
		if (next[index].windowsHide === undefined) next[index].windowsHide = true;
	}
	else return args; // 无效参数仍交给 Node 拒绝，不默默修复调用者的错误。
	return next;
}

const installed = Symbol.for("agentflux.backgroundProcessPolicy.v1");
if (process.platform === "win32" && !childProcess[installed]) {
	for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
		const original = childProcess[name];
		const arrayArgs = name !== "exec" && name !== "execSync";
		const acceptsCallback = name === "exec" || name === "execFile";
		function hidden(...args) { return Reflect.apply(original, this, hiddenOptions(args, arrayArgs, acceptsCallback)); }
		const descriptors = Object.getOwnPropertyDescriptors(original);
		// Node 的 custom promisify 闭包直接调用原始函数；只复制原 descriptor 会绕过策略。
		if (typeof original[promisify.custom] === "function") {
			const originalAsync = original[promisify.custom];
			descriptors[promisify.custom] = { ...descriptors[promisify.custom], value: function (...args) {
				return Reflect.apply(originalAsync, this, hiddenOptions(args, arrayArgs, false));
			} };
		}
		Object.defineProperties(hidden, descriptors);
		childProcess[name] = hidden;
	}
	Object.defineProperty(childProcess, installed, { value: true });
	syncBuiltinESMExports();
}
