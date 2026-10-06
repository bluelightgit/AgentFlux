import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
	PiRuntimeResolutionError,
	getPiCliPath,
	parsePiPackageBin,
	resolvePiInvocation,
} from "../src/core/pi-runtime";

const root = mkdtempSync(join(tmpdir(), "agentflux-pi-runtime-"));
let passed = 0;
const check = (condition: unknown, message: string) => {
	assert.ok(condition, message);
	passed++;
};
try {
	const actual = resolvePiInvocation();
	check(actual.provenance.kind === "node-package", "uses the SDK Host package provenance");
	check(actual.provenance.sameVersion, "Host VERSION and package manifest version match");
	check(actual.cliPath === getPiCliPath(), "CLI path comes from package bin");
	check(actual.cliPath !== undefined && existsSync(actual.cliPath), "resolved package bin exists");
	check(actual.args[0] === actual.cliPath, "invocation does not use caller argv or an adjacent guessed CLI");

	const fake = join(root, "fake-pi");
	mkdirSync(join(fake, "dist"), { recursive: true });
	const cli = join(fake, "dist", "bundle-cli.js");
	writeFileSync(cli, "#!/usr/bin/env node\n", "utf8");
	const manifest = { name: "@earendil-works/pi-coding-agent", version: "9.9.9", bin: { pi: "dist/bundle-cli.js" } };
	writeFileSync(join(fake, "package.json"), JSON.stringify(manifest), "utf8");
	const candidate = resolvePiInvocation({ hostPackageDir: fake, hostVersion: "9.9.9", hostManifest: manifest });
	check(candidate.cliPath === resolve(cli), "resolves the declared bundled bin entry");
	check(candidate.provenance.cli?.binEntry === "dist/bundle-cli.js", "records declared bin provenance");

	assert.throws(
		() => resolvePiInvocation({ hostPackageDir: fake, hostVersion: "9.9.8", hostManifest: manifest }),
		(error: unknown) => error instanceof PiRuntimeResolutionError && error.code === "host_version_mismatch",
	);
	passed++;
	assert.throws(
		() => parsePiPackageBin({ name: manifest.name, version: manifest.version, bin: { other: "dist/other.js" } }),
		(error: unknown) => error instanceof PiRuntimeResolutionError && error.code === "cli_bin_missing",
	);
	passed++;

	const binaryManifest = { ...manifest, bin: { pi: "dist/pi" } };
	writeFileSync(join(fake, "dist", "pi"), "binary", "utf8");
	assert.throws(
		() => resolvePiInvocation({ hostPackageDir: fake, hostVersion: "9.9.9", hostManifest: binaryManifest }),
		(error: unknown) => error instanceof PiRuntimeResolutionError && error.code === "standalone_binary_unsupported",
	);
	passed++;

	assert.throws(() => resolvePiInvocation({ hostPackageDir: fake, hostVersion: "0.84.1", hostManifest: { ...manifest, version: "0.84.1" } }),
		(error: unknown) => error instanceof PiRuntimeResolutionError && error.code === "host_version_unsupported");
	passed++;
	assert.throws(() => resolvePiInvocation({ hostPackageDir: fake, hostVersion: "9.9.9", hostManifest: { ...manifest, bin: "../escape.js" } }),
		(error: unknown) => error instanceof PiRuntimeResolutionError && error.code === "cli_bin_invalid");
	passed++;

	const globalPi = join(root, "global-pi");
	mkdirSync(join(globalPi, "dist"), { recursive: true });
	const globalCli = join(globalPi, "dist", "bundle-cli.js");
	writeFileSync(globalCli, "#!/usr/bin/env node\n");
	writeFileSync(join(globalPi, "package.json"), JSON.stringify(manifest));
	const realMain = resolvePiInvocation({ hostPackageDir: fake, hostVersion: "9.9.9", hostManifest: manifest, processEntryPath: globalCli });
	check(realMain.cliPath === resolve(globalCli), "actual validated global Main bin wins over adjacent local SDK");
	check(realMain.provenance.host?.selectionSource === "validated-cli-entry" && realMain.provenance.host.sdkPackageDir === resolve(fake), "provenance separates actual CLI and SDK module paths");
	assert.throws(() => resolvePiInvocation({ hostPackageDir: fake, hostVersion: "9.9.8", hostManifest: { ...manifest, version: "9.9.8" }, processEntryPath: globalCli }),
		(error: unknown) => error instanceof PiRuntimeResolutionError && error.code === "host_sdk_version_mismatch"); passed++;
	const caller = join(globalPi, "sdk-caller.js"); writeFileSync(caller, "// SDK caller, not manifest bin\n");
	const sdkCaller = resolvePiInvocation({ hostPackageDir: fake, hostVersion: "9.9.9", hostManifest: manifest, processEntryPath: caller });
	check(sdkCaller.cliPath === resolve(cli) && sdkCaller.provenance.host?.selectionSource === "sdk-module", "SDK caller argv does not select a Host package");

	const override = resolvePiInvocation({ invocationOverride: { command: process.execPath, args: ["fixture.cjs"] }, args: ["--mode", "json"] });
	check(override.provenance.kind === "test-override" && override.args.at(-1) === "json", "test invocationOverride remains available and explicitly unverified");
	console.log(`${passed} Pi runtime checks passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
