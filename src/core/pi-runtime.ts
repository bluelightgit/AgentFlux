import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { getPackageDir as hostGetPackageDir, VERSION as hostVersion } from "@earendil-works/pi-coding-agent";

/**
 * The Pi host owns the package identity.  Keep these aliases public so a live
 * supervisor can use the same source of truth as the child runner.
 */
export const getPackageDir = hostGetPackageDir;
export const VERSION = hostVersion;
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

export interface PiPackageManifest {
	name?: unknown;
	version?: unknown;
	bin?: unknown;
	piConfig?: { name?: unknown };
}

export type PiRuntimeKind = "node-package" | "test-override";

export interface PiHostProvenance {
	kind: "sdk-host";
	selectionSource?: "sdk-module" | "validated-cli-entry";
	sdkPackageDir?: string;
	sdkVersion?: string;
	processEntryPath?: string;
	packageName: string;
	packageDir: string;
	packageJsonPath: string;
	version: string;
	moduleSource: "@earendil-works/pi-coding-agent";
	runtime: "node";
}

export interface PiCliProvenance {
	kind: "package-bin";
	packageName: string;
	packageDir: string;
	packageJsonPath: string;
	version: string;
	binName: string;
	binEntry: string;
	cliPath: string;
	moduleSource: "@earendil-works/pi-coding-agent";
	runtime: "node-script";
}

export interface PiOverrideProvenance {
	kind: "test-override";
	verified: false;
	reason: "caller-supplied test invocation";
}

export interface PiRuntimeProvenance {
	kind: PiRuntimeKind;
	host: PiHostProvenance | null;
	cli: PiCliProvenance | null;
	override?: PiOverrideProvenance;
	sameVersion: boolean;
}

export interface PiInvocationDescriptor {
	command: string;
	args: string[];
	/** The package-bin path, when this is a normal Node package invocation. */
	cliPath?: string;
	/** Arguments after the package-bin path, before the caller adds run args. */
	cliArgs?: string[];
	provenance: PiRuntimeProvenance;
}

export interface PiInvocationOverride {
	command: string;
	args: string[];
}

export interface ResolvePiRuntimeOptions {
	/** Extra arguments to append after the package bin path. */
	args?: string[];
	/** Kept for deterministic unit fixtures; production callers omit it. */
	invocationOverride?: PiInvocationOverride;
	/** Explicit fixture host metadata, without consulting the installed host. */
	hostPackageDir?: string;
	hostVersion?: string;
	hostManifest?: PiPackageManifest;
	/** The executable key in an object-form package `bin`. Defaults to `pi`. */
	binName?: string;
	/** Exact Pi bin proof only; arbitrary SDK caller argv is never a Host hint. */
	processEntryPath?: string | null;
}

export class PiRuntimeResolutionError extends Error {
	readonly code:
		| "host_version_unsupported"
		| "host_package_missing"
		| "host_manifest_invalid"
		| "host_version_mismatch"
		| "host_package_mismatch"
		| "host_sdk_version_mismatch"
		| "cli_bin_missing"
		| "cli_bin_invalid"
		| "cli_missing"
		| "standalone_binary_unsupported"
		| "invalid_override";

	constructor(code: PiRuntimeResolutionError["code"], message: string) {
		super(message);
		this.name = "PiRuntimeResolutionError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readManifestFromDisk(packageDir: string): PiPackageManifest {
	const packageJsonPath = resolve(packageDir, "package.json");
	if (!existsSync(packageJsonPath)) {
		throw new PiRuntimeResolutionError(
			"host_package_missing",
			`Pi host package manifest is missing: ${packageJsonPath}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	} catch (error) {
		throw new PiRuntimeResolutionError(
			"host_manifest_invalid",
			`Pi host package manifest is unreadable: ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(parsed)) {
		throw new PiRuntimeResolutionError("host_manifest_invalid", `Pi host package manifest is not an object: ${packageJsonPath}`);
	}
	return parsed as PiPackageManifest;
}

function packageJsonPath(packageDir: string): string {
	return resolve(packageDir, "package.json");
}

function pathIsInside(root: string, candidate: string): boolean {
	const rel = relative(resolve(root), resolve(candidate));
	return rel === "" || (rel !== ".." && !rel.startsWith(".." + "/") && !rel.startsWith("..\\") && !isAbsolute(rel));
}

function cleanString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new PiRuntimeResolutionError("host_manifest_invalid", `Pi host package ${field} is missing or invalid`);
	}
	return value.trim();
}

/** Resolve the named Pi executable from the package manifest, never by path guess. */
export function parsePiPackageBin(
	manifest: PiPackageManifest,
	binName = "pi",
): { binName: string; binEntry: string } {
	const rawBin = manifest.bin;
	let entry: unknown;
	if (typeof rawBin === "string") {
		entry = rawBin;
	} else if (isRecord(rawBin)) {
		entry = rawBin[binName];
	} else {
		entry = undefined;
	}
	if (typeof entry !== "string" || entry.trim().length === 0) {
		throw new PiRuntimeResolutionError(
			"cli_bin_missing",
			`Pi host package bin.${binName} is missing; refusing to guess a CLI path`,
		);
	}
	return { binName, binEntry: entry.trim() };
}

function isNodeScriptPath(path: string): boolean {
	return [".js", ".mjs", ".cjs"].includes(extname(path).toLowerCase());
}

function isNodeExecutablePath(path: string): boolean {
	return /^(?:node|nodejs)(?:\.exe)?$/i.test(basename(path));
}

function validateHost(
	packageDirInput: string,
	manifestInput: PiPackageManifest | undefined,
	versionInput: string,
): { host: PiHostProvenance; manifest: PiPackageManifest } {
	const packageDir = resolve(packageDirInput);
	const manifest = manifestInput ?? readManifestFromDisk(packageDir);
	const packageName = cleanString(manifest.name, "name");
	const manifestVersion = cleanString(manifest.version, "version");
	const version = cleanString(versionInput, "VERSION");
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
	if (!match || (+match[1] === 0 && (+match[2] < 99 || (+match[2] === 99 && +match[3] < 1)))) {
		throw new PiRuntimeResolutionError("host_version_unsupported", `AgentFlux requires Pi >=0.99.1; found ${version}`);
	}
	if (packageName !== PI_PACKAGE_NAME) {
		throw new PiRuntimeResolutionError(
			"host_package_mismatch",
			`Pi host module package mismatch: expected ${PI_PACKAGE_NAME}, found ${packageName}`,
		);
	}
	if (manifestVersion !== version) {
		throw new PiRuntimeResolutionError(
			"host_version_mismatch",
			`Pi host VERSION ${version} does not match package.json version ${manifestVersion}`,
		);
	}
	return {
		host: {
			kind: "sdk-host",
			packageName,
			packageDir,
			packageJsonPath: packageJsonPath(packageDir),
			version,
			moduleSource: "@earendil-works/pi-coding-agent",
			runtime: "node",
		},
		manifest,
	};
}

function resolvePackageCli(
	host: PiHostProvenance,
	manifest: PiPackageManifest,
	binName: string,
): PiCliProvenance {
	const { binEntry } = parsePiPackageBin(manifest, binName);
	const cliPath = resolve(host.packageDir, binEntry);
	if (!pathIsInside(host.packageDir, cliPath)) {
		throw new PiRuntimeResolutionError(
			"cli_bin_invalid",
			`Pi package bin.${binName} points outside the host package: ${binEntry}`,
		);
	}
	if (!existsSync(cliPath)) {
		throw new PiRuntimeResolutionError(
			"cli_missing",
			`Pi package bin.${binName} is missing: ${cliPath}`,
		);
	}
	try {
		if (!statSync(cliPath).isFile()) throw new Error("not a regular file");
	} catch (error) {
		throw new PiRuntimeResolutionError(
			"cli_missing",
			`Pi package bin.${binName} is not a readable file: ${cliPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!pathIsInside(realpathSync(host.packageDir), realpathSync(cliPath))) {
		throw new PiRuntimeResolutionError("cli_bin_invalid", `Pi package bin.${binName} resolves outside the host package: ${cliPath}`);
	}
	// A Bun/SEA/installer executable is not a Node CLI script. Do not apply
	// process.execPath + argv rules to it, and do not search for a nearby .js file.
	if (!isNodeScriptPath(cliPath)) {
		throw new PiRuntimeResolutionError(
			"standalone_binary_unsupported",
			`Unsupported standalone/binary Pi CLI in package bin.${binName}: ${cliPath}`,
		);
	}
	return {
		kind: "package-bin",
		packageName: host.packageName,
		packageDir: host.packageDir,
		packageJsonPath: host.packageJsonPath,
		version: host.version,
		binName,
		binEntry,
		cliPath,
		moduleSource: "@earendil-works/pi-coding-agent",
		runtime: "node-script",
	};
}

/** Native ESM imports can resolve an adjacent SDK instead of bundled jiti aliases.
 * argv is useful only after the entry's package name AND exact manifest bin prove
 * that it is Pi itself. Ordinary SDK callers retain the public SDK identity.
 */
function identifyPiProcessEntry(entryPath: string | null | undefined, binName: string): { packageDir: string; manifest: PiPackageManifest; entryPath: string } | undefined {
	if (!entryPath || !existsSync(entryPath)) return undefined;
	const entry = realpathSync(resolve(entryPath));
	if (!isNodeScriptPath(entry)) return undefined;
	let directory = dirname(entry);
	while (dirname(directory) !== directory) {
		if (existsSync(packageJsonPath(directory))) {
			const manifest = readManifestFromDisk(directory);
			if (manifest.name !== PI_PACKAGE_NAME) return undefined;
			const { binEntry } = parsePiPackageBin(manifest, binName);
			const declared = resolve(directory, binEntry);
			if (!pathIsInside(directory, declared) || !existsSync(declared)) return undefined;
			if (realpathSync(declared) !== entry) return undefined;
			return { packageDir: directory, manifest, entryPath: entry };
		}
		directory = dirname(directory);
	}
	return undefined;
}

function resolveOverride(override: PiInvocationOverride, args: string[]): PiInvocationDescriptor {
	if (!override || typeof override.command !== "string" || override.command.trim().length === 0
		|| !Array.isArray(override.args) || override.args.some(arg => typeof arg !== "string")) {
		throw new PiRuntimeResolutionError(
			"invalid_override",
			"Pi invocationOverride must provide a command and a string args array",
		);
	}
	return {
		command: override.command,
		args: [...override.args, ...args],
		provenance: {
			kind: "test-override",
			host: null,
			cli: null,
			override: { kind: "test-override", verified: false, reason: "caller-supplied test invocation" },
			sameVersion: false,
		},
	};
}

/**
 * Resolve a Node Pi invocation from the SDK Host's package identity.
 *
 * The override is intentionally retained as a deterministic test seam. It is
 * marked unverified and must never be exposed by a production tool schema.
 */
export function resolvePiInvocation(options: ResolvePiRuntimeOptions | string[] = {}): PiInvocationDescriptor {
	const normalizedOptions: ResolvePiRuntimeOptions = Array.isArray(options) ? { args: options } : options;
	const args = normalizedOptions.args ?? [];
	if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) {
		throw new PiRuntimeResolutionError("invalid_override", "Pi invocation args must be strings");
	}
	if (normalizedOptions.invocationOverride) return resolveOverride(normalizedOptions.invocationOverride, args);

	if (process.versions.bun) {
		throw new PiRuntimeResolutionError(
			"standalone_binary_unsupported",
			"Standalone/Bun Pi hosts are unsupported by the Node child invocation adapter",
		);
	}
	const hostPackageDir = normalizedOptions.hostPackageDir ?? hostGetPackageDir();
	const hostVersionValue = normalizedOptions.hostVersion ?? hostVersion;
	const sdk = validateHost(hostPackageDir, normalizedOptions.hostManifest, hostVersionValue);
	const binName = normalizedOptions.binName ?? "pi";
	const entry = identifyPiProcessEntry(normalizedOptions.processEntryPath === undefined ? process.argv[1] : normalizedOptions.processEntryPath, binName);
	const selected = entry ? validateHost(entry.packageDir, entry.manifest, cleanString(entry.manifest.version, "version")) : sdk;
	if (selected.host.version !== sdk.host.version) {
		throw new PiRuntimeResolutionError("host_sdk_version_mismatch", `Pi Main CLI ${selected.host.version} (${selected.host.packageDir}) does not match extension SDK ${sdk.host.version} (${sdk.host.packageDir}); align the SDK dependency and restart Pi`);
	}
	const host: PiHostProvenance = { ...selected.host, selectionSource: entry ? "validated-cli-entry" : "sdk-module", sdkPackageDir: sdk.host.packageDir, sdkVersion: sdk.host.version, ...(entry ? { processEntryPath: entry.entryPath } : {}) };
	const cli = resolvePackageCli(host, selected.manifest, binName);
	if (!isNodeExecutablePath(process.execPath)) {
		throw new PiRuntimeResolutionError(
			"standalone_binary_unsupported",
			`Unsupported standalone/SEA Node host executable: ${process.execPath}`,
		);
	}
	return {
		command: process.execPath,
		args: [cli.cliPath, ...args],
		cliPath: cli.cliPath,
		cliArgs: [...args],
		provenance: { kind: "node-package", host, cli, sameVersion: host.version === cli.version },
	};
}

/** Alias used by supervisors that describe this as a runtime descriptor. */
export const resolvePiRuntime = resolvePiInvocation;
/** Compatibility alias for callers migrating the old private helper. */
export const getPiInvocation = resolvePiInvocation;

/** Read and validate the current Host package without constructing child args. */
export function inspectPiRuntime(options: Omit<ResolvePiRuntimeOptions, "args" | "invocationOverride"> = {}): PiRuntimeProvenance {
	return resolvePiInvocation(options).provenance;
}

/** Small helper for callers that only need the package-owned CLI path. */
export function getPiCliPath(options: Omit<ResolvePiRuntimeOptions, "args" | "invocationOverride"> = {}): string {
	const descriptor = resolvePiInvocation(options);
	if (!descriptor.cliPath) throw new PiRuntimeResolutionError("cli_missing", "Pi invocation has no package CLI path");
	return descriptor.cliPath;
}

/** Avoid accidentally treating a package path or binary as a Node executable. */
export function isSupportedNodePiInvocation(descriptor: PiInvocationDescriptor): boolean {
	return descriptor.provenance.kind === "node-package"
		&& descriptor.provenance.sameVersion
		&& !!descriptor.cliPath
		&& isNodeScriptPath(descriptor.cliPath)
		&& isNodeExecutablePath(descriptor.command);
}