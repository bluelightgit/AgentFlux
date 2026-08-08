import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });

const shared = {
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	sourcemap: true,
	// pi 主进程通过 jiti alias 将 @earendil-works/* 与 typebox 重定向到它自己的
	// 运行时实例（如 pi-tui 的 Editor 0.84.x）。因此打包时不得内联这些包，否则
	// 扩展会 patch 一个主进程从不使用的重复类（旧版双实例问题），slash 参数补全
	// 等 bridge 会静默失效。
	external: ["@earendil-works/*", "typebox"],
};

const sharedCjs = {
	bundle: true,
	platform: "node",
	target: "node20",
	format: "cjs",
	sourcemap: true,
	// host/contracts 面向 PiDeck 主进程消费，同样解析到运行时提供的实例。
	external: ["@earendil-works/*", "typebox"],
	define: { "import.meta.url": "__agentfluxImportMetaUrl" },
	banner: { js: "const __agentfluxImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
};

await Promise.all([
	build({ ...shared, entryPoints: ["src/entry.ts"], outfile: "dist/extension/entry.js" }),
	build({ ...shared, entryPoints: ["src/subagent-entry.ts"], outfile: "dist/extension/subagent-entry.js" }),
	build({ ...shared, entryPoints: ["src/host/index.ts"], outfile: "dist/host/index.js" }),
	build({ ...sharedCjs, entryPoints: ["src/host/index.ts"], outfile: "dist/host/index.cjs" }),
	build({ ...shared, entryPoints: ["src/contracts/index.ts"], outfile: "dist/contracts/index.js" }),
	build({ ...sharedCjs, entryPoints: ["src/contracts/index.ts"], outfile: "dist/contracts/index.cjs" }),
]);
