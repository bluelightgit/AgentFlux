import assert from "node:assert/strict";
import cp, { spawn as namedSpawn } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const [mode, preload] = process.argv.slice(2);
if (mode.startsWith("mock")) {
	Object.defineProperty(process, "platform", { value: mode === "mock-win" ? "win32" : "linux" });
	const calls = [];
	const child = { pid: 123 };
	for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
		const spy = function (...args) { calls.push({ name, args, receiver: this }); const cb = args.at(-1); if (typeof cb === "function") cb(null, "ok", ""); return child; };
		if (name === "exec" || name === "execFile") Object.defineProperty(spy, promisify.custom, { value: function (...args) {
			calls.push({ name: `${name}-promise`, args, receiver: this }); const promise = Promise.resolve({ stdout: "ok", stderr: "" }); promise.child = child; return promise;
		} });
		cp[name] = spy;
	}
	const original = cp.spawn;
	await import(pathToFileURL(preload).href);
	if (mode === "mock-linux") {
		assert.equal(cp.spawn, original);
		assert.equal(calls.length, 0);
	} else {
		assert.notEqual(cp.spawn, original);
		assert.equal(namedSpawn, cp.spawn, "ESM bindings must use the same policy");
		const wrapped = cp.spawn;
		await import(`${pathToFileURL(preload).href}?second-load`);
		assert.equal(cp.spawn, wrapped, "installation must be idempotent");
		const signal = new AbortController().signal;
		const env = { SAMPLE: "unchanged" };
		const options = { detached: true, cwd: "workspace", stdio: "pipe", env, signal, timeout: 321 };
		for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
			for (const argv of [["file"], ["file", ["arg"]], ["file", options], ["file", ["arg"], options], ["file", undefined, options], ["file", null, options]]) {
				const result = cp[name](...argv); assert.equal(result, child);
				const actual = calls.at(-1).args; const opt = actual[Array.isArray(actual[1]) || actual[1] == null ? 2 : 1];
				assert.equal(opt.windowsHide, true);
				if (argv.includes(options)) { assert.deepEqual(opt, { ...options, windowsHide: true }); assert.equal(opt.env, env); assert.equal(opt.signal, signal); }
			}
		}
		let callbacks = 0;
		for (const argv of [["file", () => callbacks++], ["file", ["arg"], () => callbacks++], ["file", undefined, options, () => callbacks++], ["file", options, () => callbacks++]]) cp.execFile(...argv);
		for (const name of ["exec", "execSync"]) for (const opt of [undefined, null, options]) {
			cp[name]("command", opt); assert.deepEqual(calls.at(-1).args[1], { ...(opt ?? {}), windowsHide: true });
		}
		cp.exec("command", () => callbacks++);
		assert.equal(callbacks, 5);
		for (const name of ["exec", "execFile"]) {
			const promise = promisify(cp[name])("file", options);
			assert.equal(promise.child, child);
			assert.deepEqual(await promise, { stdout: "ok", stderr: "" });
			assert.equal(calls.at(-1).args[1].windowsHide, true);
		}
		for (const argv of [["file", 42], ["file", [], "invalid-options"]]) {
			cp.spawn(...argv); assert.deepEqual(calls.at(-1).args, argv, "invalid argument shapes must reach Node unchanged");
		}
		assert.equal(Object.hasOwn(options, "windowsHide"), false, "caller options must not be mutated");
		cp.spawn("unspecified", [], { windowsHide: undefined });
		assert.equal(calls.at(-1).args[2].windowsHide, true);
		cp.spawn("interactive", [], { windowsHide: false });
		assert.equal(calls.at(-1).args[2].windowsHide, false, "explicit interactive intent must remain intact");
	}
	console.log(JSON.stringify({ passed: true, mode, calls: calls.length }));
} else {
	// 实际 Node API；Windows 启用策略，POSIX 保持原生选项。无需 Provider。
	const command = process.execPath;
	const argv = ["-e", "process.stdout.write('NATIVE_OK')"];
	await import(pathToFileURL(preload).href);
	for (const args of [[command, argv], [command, argv, {}], [command, undefined, { timeout: 1000 }]]) {
		if (args[1] === undefined) continue; // 不启动没有命令正文的交互 Node。
		assert.equal(cp.execFileSync(...args).toString(), "NATIVE_OK");
	}
	await new Promise((resolve, reject) => cp.execFile(command, argv, (error, stdout) => { if (error) reject(error); else { assert.equal(stdout, "NATIVE_OK"); resolve(); } }));
	assert.equal((await promisify(cp.execFile)(command, argv)).stdout, "NATIVE_OK");
	assert.equal(cp.spawnSync(command, argv).stdout.toString(), "NATIVE_OK");
	for (const args of [[command, 42], [command, [], "bad"]]) assert.throws(() => cp.spawn(...args), { code: "ERR_INVALID_ARG_TYPE" });
	await assert.rejects(promisify(cp.execFile)(command, ["-e", "process.exit(7)"]), { code: 7 });
	await assert.rejects(promisify(cp.execFile)(command, ["-e", "setTimeout(()=>{},10000)"], { timeout: 50 }));
	const controller = new AbortController();
	const abort = promisify(cp.execFile)(command, ["-e", "setTimeout(()=>{},10000)"], { signal: controller.signal });
	controller.abort(); await assert.rejects(abort, { name: "AbortError" });
	console.log(JSON.stringify({ passed: true, mode, platform: process.platform }));
}
