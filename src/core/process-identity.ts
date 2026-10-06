import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

export type ProcessPlatform = "win32" | "linux";

export interface ProcessIdentity {
	version: 1;
	pid: number;
	platform: ProcessPlatform;
	birth: string;
}

export type ProcessObservation =
	| { state: "alive"; identity: ProcessIdentity }
	| { state: "dead" }
	| { state: "unknown"; reason: string };

type ProbeResult = ProcessObservation;

const WINDOWS_PROBE_TIMEOUT_MS = 2_000;
const WINDOWS_BIRTH_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})Z$/;
const LINUX_BIRTH_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(0|[1-9]\d*)$/;
const WINDOWS_MISSING = "AGENTFLUX_PROCESS_MISSING";
const WINDOWS_PERMISSION = "AGENTFLUX_PROCESS_PERMISSION";
const WINDOWS_INVALID = "AGENTFLUX_PROCESS_INVALID";
const WINDOWS_ERROR = "AGENTFLUX_PROCESS_ERROR";

/*
 * CIM's CreationDate is the OS creation timestamp rather than an observation
 * made by this process.  The command is deliberately self-contained: it has
 * no provider, network, or project-store dependency and is bounded by the
 * synchronous child-process timeout below.
 */
const WINDOWS_PROBE_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"$targetPid = [uint32]$env:AGENTFLUX_PID",
	"try {",
	`  $process = @(Get-CimInstance -ClassName Win32_Process -Filter (\"ProcessId = {0}\" -f $targetPid) -ErrorAction Stop) | Where-Object { $_.ProcessId -eq $targetPid } | Select-Object -First 1`,
	`  if ($null -eq $process) { Write-Output '${WINDOWS_MISSING}'; exit 2 }`,
	`  if ($null -eq $process.CreationDate) { Write-Output '${WINDOWS_INVALID}'; exit 4 }`,
	"  Write-Output $process.CreationDate.ToUniversalTime().ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)",
	"  exit 0",
	"} catch {",
	"  $type = $_.Exception.GetType().FullName",
	`  if ($type -match 'UnauthorizedAccess|SecurityException|Win32Exception|AccessDenied') { Write-Output '${WINDOWS_PERMISSION}'; exit 3 }`,
	`  Write-Output '${WINDOWS_ERROR}'; exit 4`,
	"}",
].join("; ");

let currentProcessIdentity: ProcessIdentity | undefined;

function isSupportedPlatform(value: string): value is ProcessPlatform {
	return value === "win32" || value === "linux";
}

function isPid(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function copyIdentity(identity: ProcessIdentity): ProcessIdentity {
	return {
		version: 1,
		pid: identity.pid,
		platform: identity.platform,
		birth: identity.birth,
	};
}

function unknown(reason: string): ProbeResult {
	return { state: "unknown", reason };
}

function isCanonicalWindowsBirth(value: string): boolean {
	const match = WINDOWS_BIRTH_PATTERN.exec(value);
	if (!match) return false;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return false;
	const date = new Date(timestamp);
	return date.getUTCFullYear() === Number(match[1])
		&& date.getUTCMonth() + 1 === Number(match[2])
		&& date.getUTCDate() === Number(match[3])
		&& date.getUTCHours() === Number(match[4])
		&& date.getUTCMinutes() === Number(match[5])
		&& date.getUTCSeconds() === Number(match[6])
		&& date.getUTCMilliseconds() === Number(match[7].slice(0, 3));
}

function isCanonicalLinuxBirth(value: string): boolean {
	return LINUX_BIRTH_PATTERN.test(value);
}

function isCanonicalBirth(platform: ProcessPlatform, birth: string): boolean {
	return platform === "win32" ? isCanonicalWindowsBirth(birth) : isCanonicalLinuxBirth(birth);
}

type LinuxStat = { state: string; startTime: string };

export function parseLinuxStat(pid: number, stat: string): LinuxStat | undefined {
	const firstSpace = stat.indexOf(" ");
	if (firstSpace <= 0 || stat.slice(0, firstSpace) !== String(pid)) return undefined;

	/* The command name is parenthesized and may itself contain spaces or ')'. */
	const closingParen = stat.lastIndexOf(")");
	if (closingParen <= firstSpace) return undefined;
	const fieldsAfterCommand = stat.slice(closingParen + 1).trim().split(/\s+/);
	/* starttime is field 22; after pid/comm, state is index 0, so index 19. */
	const state = fieldsAfterCommand[0];
	const startTime = fieldsAfterCommand[19];
	if (!state || !/^[A-Za-z]$/.test(state) || !startTime || !/^\d+$/.test(startTime)) return undefined;
	return { state, startTime };
}

function readLinuxIdentity(pid: number): ProbeResult {
	/* An unavailable /proc mount is a probe failure, not evidence of exit. */
	try {
		readFileSync("/proc/self/stat", "utf8");
	} catch (error) {
		const code = errorCode(error);
		if (code === "EACCES" || code === "EPERM") {
			return unknown("permission denied while reading Linux process metadata");
		}
		return unknown(`Linux process metadata is unavailable${code ? ` (${code})` : ""}`);
	}

	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT" || code === "ESRCH") return { state: "dead" };
		if (code === "EACCES" || code === "EPERM") {
			return unknown("permission denied while reading Linux process metadata");
		}
		return unknown(`Linux process metadata probe failed${code ? ` (${code})` : ""}`);
	}

	const parsedStat = parseLinuxStat(pid, stat);
	if (!parsedStat) return unknown("Linux process metadata has an invalid /proc stat format");
	if (parsedStat.state === "Z" || parsedStat.state === "X") return { state: "dead" };

	let bootId: string;
	try {
		bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch (error) {
		const code = errorCode(error);
		if (code === "EACCES" || code === "EPERM") {
			return unknown("permission denied while reading Linux boot identity");
		}
		return unknown(`Linux boot identity probe failed${code ? ` (${code})` : ""}`);
	}
	if (!bootId) return unknown("Linux boot identity is unavailable");
	const birth = `${bootId}:${parsedStat.startTime}`;
	if (!isCanonicalLinuxBirth(birth)) return unknown("Linux boot identity has an invalid format");

	return {
		state: "alive",
		identity: {
			version: 1,
			pid,
			platform: "linux",
			birth,
		},
	};
}

type ProcessLiveness =
	| { state: "alive" }
	| { state: "dead" }
	| { state: "unknown"; reason: string };

function probeWindowsLiveness(pid: number): ProcessLiveness {
	try {
		process.kill(pid, 0);
		return { state: "alive" };
	} catch (error) {
		const code = errorCode(error);
		if (code === "ESRCH") return { state: "dead" };
		if (code === "EPERM") return { state: "unknown", reason: "permission denied while checking Windows process liveness" };
		return { state: "unknown", reason: `Windows process liveness probe failed${code ? ` (${code})` : ""}` };
	}
}

export interface WindowsProbeResult {
	stdout: string;
	status: number | null;
	signal: string | null;
	error?: unknown;
}

export function parseWindowsProbeResult(pid: number, result: WindowsProbeResult): ProbeResult {
	if (!isPid(pid)) return unknown("invalid process id");
	if (result.error) {
		const code = errorCode(result.error);
		if (code === "EACCES" || code === "EPERM") {
			return unknown("permission denied while probing Windows process identity");
		}
		if (code === "ETIMEDOUT") return unknown("Windows process identity probe timed out");
		return unknown(`Windows process identity probe failed${code ? ` (${code})` : ""}`);
	}
	if (result.status === null || result.signal !== null) {
		return unknown("Windows process identity probe ended without a result");
	}

	const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	if (result.status === 2 && lines.length === 1 && lines[0] === WINDOWS_MISSING) return { state: "dead" };
	if (lines.includes(WINDOWS_PERMISSION)) {
		return unknown("permission denied while querying Windows process creation time");
	}
	if (lines.includes(WINDOWS_INVALID)) {
		return unknown("Windows process creation-time probe returned invalid data");
	}
	if (lines.includes(WINDOWS_ERROR)) {
		return unknown("Windows process creation-time probe failed");
	}

	const birth = lines[lines.length - 1];
	if (result.status !== 0 || lines.length !== 1 || !birth || !isCanonicalWindowsBirth(birth)) {
		return unknown("Windows process creation-time probe returned invalid data");
	}

	return {
		state: "alive",
		identity: { version: 1, pid, platform: "win32", birth },
	};
}

function readWindowsIdentity(pid: number): ProbeResult {
	const liveness = probeWindowsLiveness(pid);
	if (liveness.state === "dead") return { state: "dead" };
	if (liveness.state === "unknown") return liveness;

	let result: ReturnType<typeof spawnSync>;
	try {
		result = spawnSync(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE_SCRIPT],
			{
				encoding: "utf8",
				windowsHide: true,
				timeout: WINDOWS_PROBE_TIMEOUT_MS,
				maxBuffer: 16 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, AGENTFLUX_PID: String(pid) },
			},
		);
	} catch (error) {
		return parseWindowsProbeResult(pid, { stdout: "", status: null, signal: null, error });
	}

	return parseWindowsProbeResult(pid, {
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		status: result.status,
		signal: result.signal,
		error: result.error,
	});
}

function observeWindowsIdentityAsync(pid: number): Promise<ProbeResult> {
	const liveness = probeWindowsLiveness(pid);
	if (liveness.state === "dead") return Promise.resolve({ state: "dead" });
	if (liveness.state === "unknown") return Promise.resolve(liveness);

	return new Promise(resolve => {
		const maxOutput = 16 * 1024;
		let stdout = "";
		let outputTooLarge = false;
		let spawnError: unknown;
		let timedOut = false;
		let finished = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let child: ChildProcess;
		const timeoutError = Object.assign(new Error("Windows process identity probe timed out"), { code: "ETIMEDOUT" });
		const finish = (status: number | null, signal: string | null): void => {
			if (finished) return;
			finished = true;
			if (timeout) clearTimeout(timeout);
			const result = parseWindowsProbeResult(pid, {
				stdout: outputTooLarge ? "" : stdout,
				status,
				signal,
				error: timedOut ? timeoutError : spawnError,
			});
			resolve(result);
		};

		try {
			child = spawn(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE_SCRIPT],
				{
					windowsHide: true,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, AGENTFLUX_PID: String(pid) },
				},
			);
		} catch (error) {
			resolve(parseWindowsProbeResult(pid, { stdout: "", status: null, signal: null, error }));
			return;
		}

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", chunk => {
			if (stdout.length < maxOutput) stdout += String(chunk).slice(0, maxOutput - stdout.length);
			if (stdout.length >= maxOutput) outputTooLarge = true;
		});
		/* Drain stderr so a diagnostic cannot block the owned helper. */
		child.stderr?.resume();
		child.once("error", error => { spawnError = error; });
		child.once("close", (status, signal) => finish(status, signal));
		timeout = setTimeout(() => {
			timedOut = true;
			try { child.kill(); } catch { /* close still owns completion */ }
		}, WINDOWS_PROBE_TIMEOUT_MS);
		if (finished) clearTimeout(timeout);
	});
}

function probeProcess(pid: number): ProbeResult {
	const platform = process.platform;
	if (!isSupportedPlatform(platform)) return unknown(`unsupported platform: ${platform}`);
	if (platform === "win32") return readWindowsIdentity(pid);
	return readLinuxIdentity(pid);
}

function observeWithCurrentCache(pid: number): ProbeResult {
	const platform = process.platform;
	if (pid === process.pid && currentProcessIdentity
		&& currentProcessIdentity.pid === pid && currentProcessIdentity.platform === platform) {
		return { state: "alive", identity: copyIdentity(currentProcessIdentity) };
	}

	const result = probeProcess(pid);
	if (pid === process.pid && result.state === "alive") {
		currentProcessIdentity = copyIdentity(result.identity);
	}
	return result.state === "alive" ? { state: "alive", identity: copyIdentity(result.identity) } : result;
}

export function isProcessIdentity(value: unknown): value is ProcessIdentity {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const identity = value as Record<string, unknown>;
		return identity.version === 1
			&& isPid(identity.pid)
			&& isSupportedPlatform(typeof identity.platform === "string" ? identity.platform : "")
			&& typeof identity.birth === "string"
			&& isCanonicalBirth(identity.platform as ProcessPlatform, identity.birth);
	} catch {
		return false;
	}
}

export function observeProcess(pid: number): ProcessObservation {
	if (!isPid(pid)) return unknown("invalid process id");
	return observeWithCurrentCache(pid);
}

/**
 * Asynchronous observation for runtime paths that cannot block their event
 * loop on the Windows PowerShell/CIM helper.  It intentionally shares the
 * same liveness and output parser as the synchronous API and does not cache
 * positive observations for external PIDs.
 */
export async function observeProcessAsync(pid: number): Promise<ProcessObservation> {
	if (!isPid(pid)) return unknown("invalid process id");
	const platform = process.platform;
	if (!isSupportedPlatform(platform)) return unknown(`unsupported platform: ${platform}`);
	if (pid === process.pid && currentProcessIdentity
		&& currentProcessIdentity.pid === pid && currentProcessIdentity.platform === platform) {
		return { state: "alive", identity: copyIdentity(currentProcessIdentity) };
	}

	const result = platform === "win32"
		? await observeWindowsIdentityAsync(pid)
		: readLinuxIdentity(pid);
	if (pid === process.pid && result.state === "alive") currentProcessIdentity = copyIdentity(result.identity);
	return result.state === "alive" ? { state: "alive", identity: copyIdentity(result.identity) } : result;
}

export function getProcessIdentity(pid: number = process.pid): ProcessIdentity | undefined {
	const observation = observeProcess(pid);
	return observation.state === "alive" ? copyIdentity(observation.identity) : undefined;
}

function identitiesMatch(left: ProcessIdentity, right: ProcessIdentity): boolean {
	return left.version === right.version
		&& left.pid === right.pid
		&& left.platform === right.platform
		&& left.birth === right.birth;
}

export function checkProcessIdentity(
	pid: number,
	expected?: ProcessIdentity,
): "same" | "gone" | "reused" | "unknown" {
	/* An invalid expected identity is never treated as an omitted identity. */
	if (expected !== undefined) {
		if (!isProcessIdentity(expected) || expected.pid !== pid || expected.platform !== process.platform) {
			return "unknown";
		}
	}

	const observation = observeProcess(pid);
	if (observation.state === "dead") return "gone";
	if (observation.state === "unknown") return "unknown";
	if (expected === undefined) return "unknown";
	return identitiesMatch(observation.identity, expected) ? "same" : "reused";
}
