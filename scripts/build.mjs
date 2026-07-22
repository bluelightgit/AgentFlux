import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });

const shared = {
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	sourcemap: true,
};

const sharedCjs = {
	bundle: true,
	platform: "node",
	target: "node20",
	format: "cjs",
	sourcemap: true,
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
