import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
	checkProcessIdentity,
	getProcessIdentity,
	isProcessIdentity,
	observeProcess,
	observeProcessAsync,
	parseWindowsProbeResult,
	parseLinuxStat,
	type ProcessIdentity,
} from "../src/core/process-identity";

let passed = 0;

function check(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`✓ ${name}`);
	} catch (error) {
		console.error(`✗ ${name}:`, error);
		process.exitCode = 1;
	}
}

function timed<T>(fn: () => T): { value: T; milliseconds: number } {
	const started = performance.now();
	const value = fn();
	return { value, milliseconds: performance.now() - started };
}

async function timedAsync<T>(fn: () => Promise<T>): Promise<{ value: T; milliseconds: number }> {
	const started = performance.now();
	const value = await fn();
	return { value, milliseconds: performance.now() - started };
}

function waitForSpawn(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		if (child.pid !== undefined) {
			resolve();
			return;
		}
		child.once("spawn", () => resolve());
		child.once("error", reject);
	});
}

function stopOwnedChild(child: ChildProcess): Promise<void> {
	return new Promise(resolve => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		child.once("close", () => resolve());
		child.kill();
	});
}

async function spawnOwnedChild(): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
		stdio: "ignore",
		windowsHide: true,
	});
	await waitForSpawn(child);
	return child;
}

function fixtureBirth(platform: ProcessIdentity["platform"]): string {
	return platform === "win32"
		? "2026-01-02T03:04:05.0000000Z"
		: "01234567-89ab-4cde-8fab-0123456789ab:123";
}

function makeDifferentBirth(identity: ProcessIdentity): string {
	if (identity.platform === "win32") {
		return identity.birth.replace(/(\d)Z$/, (_match, digit: string) => `${digit === "0" ? "1" : "0"}Z`);
	}
	const separator = identity.birth.lastIndexOf(":");
	return `${identity.birth.slice(0, separator + 1)}${BigInt(identity.birth.slice(separator + 1)) + 1n}`;
}

async function main(): Promise<void> {
	const supported = process.platform === "win32" || process.platform === "linux";
	check("identity validator accepts canonical v1 births", () => {
		for (const platform of ["win32", "linux"] as const) {
			const value: ProcessIdentity = {
				version: 1,
				pid: process.pid,
				platform,
				birth: fixtureBirth(platform),
			};
			assert.equal(isProcessIdentity(value), true);
			assert.equal(isProcessIdentity({ ...value, extra: "ignored" }), true);
		}
	});

	check("identity validator rejects malformed and permission-shaped values", () => {
		const validPlatform: ProcessIdentity["platform"] = process.platform === "linux" ? "linux" : "win32";
		const valid = {
			version: 1,
			pid: process.pid,
			platform: validPlatform,
			birth: fixtureBirth(validPlatform),
		};
		for (const value of [
			undefined,
			null,
			[],
			{ ...valid, version: 2 },
			{ ...valid, pid: 0 },
			{ ...valid, pid: 1.5 },
			{ ...valid, pid: Number.NaN },
			{ ...valid, platform: "darwin" },
			{ ...valid, birth: "" },
			{ ...valid, birth: "   " },
			{ ...valid, birth: "birth" },
			{ ...valid, birth: "2026-01-02T03:04:05.000Z" },
			{ ...valid, birth: undefined },
			{ version: 1, pid: process.pid, platform: "linux", birth: "01234567-89AB-4cde-8fab-0123456789ab:123" },
			{ version: 1, pid: process.pid, platform: "linux", birth: "01234567-89ab-4cde-8fab-0123456789ab:01" },
		]) {
			assert.equal(isProcessIdentity(value), false, JSON.stringify(value));
		}
	});

	check("Windows error, timeout and partial output never establish exit", () => {
		const missing = { stdout: "AGENTFLUX_PROCESS_MISSING", status: 2, signal: null };
		assert.equal(parseWindowsProbeResult(123, missing).state, "dead");
		for (const code of ["ETIMEDOUT", "EPERM", "EACCES", "EIO"]) {
			assert.equal(parseWindowsProbeResult(123, { ...missing, error: { code } }).state, "unknown");
		}
		assert.equal(parseWindowsProbeResult(123, { ...missing, status: 1 }).state, "unknown");
		assert.equal(parseWindowsProbeResult(123, { ...missing, stdout: missing.stdout + "\npartial" }).state, "unknown");
		assert.equal(parseWindowsProbeResult(123, { ...missing, signal: "SIGTERM" }).state, "unknown");
		assert.equal(parseWindowsProbeResult(123, { stdout: "permission denied", status: 3, signal: null }).state, "unknown");
		assert.equal(parseWindowsProbeResult(123, { stdout: "2026-02-31T03:04:05.0000000Z", status: 0, signal: null }).state, "unknown");
	});
	check("Linux stat preserves command parentheses and zero start ticks", () => {
		const fields = ["S", ...Array.from({ length: 18 }, () => "0"), "0"];
		assert.deepEqual(parseLinuxStat(123, `123 (a tricky) process) ${fields.join(" ")}`), { state: "S", startTime: "0" });
		assert.equal(parseLinuxStat(124, `123 (name) ${fields.join(" ")}`), undefined);
		assert.equal(parseLinuxStat(123, "123 (incomplete) S 0"), undefined);
		assert.equal(isProcessIdentity({ version: 1, pid: 123, platform: "linux", birth: "01234567-89ab-4cde-8fab-0123456789ab:0" }), true);
	});
	check("invalid process probes are unknown rather than dead", () => {
		const observation = observeProcess(0);
		assert.equal(observation.state, "unknown");
		if (observation.state === "unknown") assert.match(observation.reason, /invalid process id/);
		assert.equal(checkProcessIdentity(0), "unknown");
	});

	if (!supported) {
		check("unsupported platforms fail closed", () => {
			assert.equal(observeProcess(process.pid).state, "unknown");
			assert.equal(getProcessIdentity(), undefined);
		});
		console.log(`\n${passed} process-identity checks passed (unsupported platform; live-process checks skipped)`);
		return;
	}

	const first = timed(() => getProcessIdentity());
	assert.ok(first.value, "current process identity should be observable");
	const current = first.value as ProcessIdentity;
	const second = timed(() => getProcessIdentity());
	check("current process identity has the required platform and PID", () => {
		assert.equal(current.version, 1);
		assert.equal(current.pid, process.pid);
		assert.equal(current.platform, process.platform);
		assert.ok(current.birth.length > 0);
	});
	check("current identity observation is alive and cached locally", () => {
		const observation = observeProcess(process.pid);
		assert.equal(observation.state, "alive");
		if (observation.state === "alive") assert.deepEqual(observation.identity, current);
		assert.equal(checkProcessIdentity(process.pid), "unknown", "a live legacy PID is not enough");
		assert.equal(checkProcessIdentity(process.pid, current), "same");
		assert.ok(second.value);
		assert.deepEqual(second.value, current);
	});
	console.log(`Current-process identity query timing: first=${first.milliseconds.toFixed(1)}ms, cached=${second.milliseconds.toFixed(1)}ms`);

	check("malformed or mismatched expected identities fail closed", () => {
		assert.equal(checkProcessIdentity(process.pid, { ...current, birth: "" }), "unknown");
		assert.equal(checkProcessIdentity(process.pid, { ...current, version: 2 } as unknown as ProcessIdentity), "unknown");
		assert.equal(checkProcessIdentity(process.pid, { ...current, pid: process.pid + 1 }), "unknown");
		assert.equal(checkProcessIdentity(process.pid, { ...current, platform: process.platform === "win32" ? "linux" : "win32" }), "unknown");
	});

	check("same PID with a different birth is reused", () => {
		const changed = { ...current, birth: makeDifferentBirth(current) };
		assert.equal(isProcessIdentity(changed), true);
		assert.equal(checkProcessIdentity(process.pid, changed), "reused");
	});
	const invalidAsync = await observeProcessAsync(0);
	check("async invalid process probes also fail closed", () => {
		assert.equal(invalidAsync.state, "unknown");
	});

	let firstChild: ChildProcess | undefined;
	let secondChild: ChildProcess | undefined;
	try {
		firstChild = await spawnOwnedChild();
		secondChild = await spawnOwnedChild();
		const firstChildPid = firstChild.pid;
		const secondChildPid = secondChild.pid;
		assert.ok(firstChildPid && secondChildPid);
		const firstChildIdentity = getProcessIdentity(firstChildPid);
		const secondChildIdentity = getProcessIdentity(secondChildPid);
		const asyncChildQuery = await timedAsync(() => observeProcessAsync(secondChildPid));
		const asyncChildObservation = asyncChildQuery.value;
		check("owned live children have distinct actual identities", () => {
			assert.ok(firstChildIdentity);
			assert.ok(secondChildIdentity);
			assert.notEqual(firstChildIdentity?.pid, current.pid);
			assert.notEqual(secondChildIdentity?.pid, current.pid);
			assert.notEqual(firstChildIdentity?.pid, secondChildIdentity?.pid);
			assert.notEqual(firstChildIdentity?.birth, current.birth);
			assert.notEqual(secondChildIdentity?.birth, current.birth);
			assert.equal(checkProcessIdentity(firstChildPid, firstChildIdentity), "same");
			assert.equal(checkProcessIdentity(secondChildPid, secondChildIdentity), "same");
			assert.equal(asyncChildObservation.state, "alive");
			if (asyncChildObservation.state === "alive") assert.deepEqual(asyncChildObservation.identity, secondChildIdentity);
		});
		console.log(`Async external identity query timing: ${asyncChildQuery.milliseconds.toFixed(1)}ms`);

		const missingPid = Math.max(firstChildPid, secondChildPid) + 100_000;
		const missing = observeProcess(missingPid);
		const missingAsync = await observeProcessAsync(missingPid);
		check("a proven missing PID is dead, not unknown", () => {
			assert.equal(missing.state, "dead");
			assert.equal(missingAsync.state, "dead");
			assert.equal(checkProcessIdentity(missingPid), "gone");
		});

		const preservedFirst = firstChildIdentity;
		await stopOwnedChild(firstChild);
		firstChild = undefined;
		const asyncGone = await observeProcessAsync(firstChildPid);
		check("an external positive observation is not cached after exit", () => {
			assert.ok(preservedFirst);
			assert.equal(observeProcess(firstChildPid).state, "dead");
			assert.equal(asyncGone.state, "dead");
			assert.equal(checkProcessIdentity(firstChildPid, preservedFirst), "gone");
		});
	} finally {
		if (firstChild) await stopOwnedChild(firstChild);
		if (secondChild) await stopOwnedChild(secondChild);
	}

	if (process.platform === "win32") {
		const protectedProbe = await observeProcessAsync(4);
		if (protectedProbe.state === "unknown") {
			check("permission-denied Windows probes fail closed", () => {
				assert.match(protectedProbe.reason, /permission|probe/i);
			});
		} else {
			console.log("Permission-path note: Windows PID 4 was queryable in this account; no access-denied branch was observable.");
		}
	} else {
		const initProbe = observeProcess(1);
		if (initProbe.state === "unknown") {
			check("permission-denied Linux probes fail closed", () => {
				assert.match(initProbe.reason, /permission|probe|metadata/i);
			});
		} else {
			console.log("Permission-path note: Linux PID 1 was queryable in this account; no access-denied branch was observable.");
		}
	}

	console.log(`\n${passed} process-identity checks passed`);
	if (process.exitCode) process.exit(1);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
