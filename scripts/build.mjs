import { copyFile, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });

const shared = {
	bundle: true,
	platform: "node",
	target: "node22",
	format: "esm",
	sourcemap: true,
	// Pi 的扩展 loader/virtual module mapping 提供 Host SDK 与 TypeBox 实例。
	// 保持 external，避免 bundled CLI/SDK Host 中重复类、注册表和初始化。
	external: ["@earendil-works/*", "typebox"],
};

await Promise.all([
	build({ ...shared, entryPoints: ["src/entry.ts"], outfile: "dist/extension/entry.js" }),
	build({ ...shared, entryPoints: ["src/subagent-entry.ts"], outfile: "dist/extension/subagent-entry.js" }),
]);
await copyFile(new URL("../src/extension/host-entry.ts", import.meta.url), new URL("../dist/extension/host-entry.ts", import.meta.url));
await copyFile(new URL("../src/agents/background-preload.mjs", import.meta.url), new URL("../dist/extension/background-preload.mjs", import.meta.url));
