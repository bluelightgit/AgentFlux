import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createWorkflowDefinition,
	deleteWorkflowDefinition,
	formatWorkflowDefinitions,
	getWorkflowDefinition,
	listWorkflowDefinitions,
	reviseWorkflowDefinition,
} from "../src/workflows/workflow-registry";
import type { TaskDAG } from "../src/workflows/dag-executor";

let passed = 0;
function check(name: string, assertion: () => void): void {
	assertion();
	passed++;
	console.log(`✓ ${name}`);
}

const root = mkdtempSync(join(tmpdir(), "agentflux-workflow-registry-"));
try {
	const firstDag: TaskDAG = { description: "design then review", nodes: [] };
	const created = createWorkflowDefinition(root, { name: "release-review", dag: firstDag, sourceTaskId: "task-1" });
	check("Workflow definition starts at version one", () => assert.equal(created.version, 1));
	check("Workflow can be resolved by id or name", () => {
		assert.equal(getWorkflowDefinition(root, created.id)?.id, created.id);
		assert.equal(getWorkflowDefinition(root, "release-review")?.id, created.id);
	});
	const revised = reviseWorkflowDefinition(root, created.id, {
		dag: { description: "design, test, review", nodes: [] },
		sourceTaskId: "task-2",
	});
	check("Workflow revision preserves identity and increments version", () => {
		assert.equal(revised.id, created.id);
		assert.equal(revised.version, 2);
	});
	check("Version selectors preserve historical definitions", () => {
		assert.equal(getWorkflowDefinition(root, `${created.id}@1`)?.description, "design then review");
		assert.equal(getWorkflowDefinition(root, created.id)?.description, "design, test, review");
	});
	check("Default listing returns only the latest version", () => {
		assert.deepEqual(listWorkflowDefinitions(root).map(item => item.version), [2]);
		assert.equal(listWorkflowDefinitions(root, true).length, 2);
	});
	const hostFluxDir = join(root, ".agentflux");
	const hostCreated = createWorkflowDefinition(hostFluxDir, { name: "desktop-history", dag: firstDag });
	reviseWorkflowDefinition(hostFluxDir, hostCreated.id, {
		dag: { description: "desktop history v2", nodes: [] },
	});
	check("Workflow 修订保留全部版本（1 和 2，供历史任务读取）", () => {
		const all = JSON.parse(readFileSync(join(hostFluxDir, "runtime", "workflows.json"), "utf-8")).definitions
			.filter((item: any) => item.id === hostCreated.id)
			.map((item: any) => item.version)
			.sort();
		assert.deepEqual(all, [1, 2]);
	});
	check("Formatting exposes reusable selector and node count", () => {
		assert.match(formatWorkflowDefinitions([revised]), new RegExp(`${created.id}@2`));
		assert.match(formatWorkflowDefinitions([revised]), /0 nodes/);
	});
	const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
	const worker = resolve("tests/helpers/transactional-store-worker.ts");
	await Promise.all(Array.from({ length: 4 }, (_, workerIndex) => new Promise<void>((resolveWorker, rejectWorker) => {
		const child = spawn(process.execPath, [tsxCli, worker, "workflow", root, `w${workerIndex}`, "3", created.id], {
			cwd: process.cwd(),
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", chunk => { stderr += chunk.toString(); });
		child.on("error", rejectWorker);
		child.on("exit", code => code === 0 ? resolveWorker() : rejectWorker(new Error(`workflow registry worker exited ${code}: ${stderr}`)));
	})));
	check("Concurrent Workflow revisions receive unique monotonic versions", () => {
		const versions = listWorkflowDefinitions(root, true)
			.filter(item => item.id === created.id)
			.map(item => item.version)
			.sort((a, b) => a - b);
		// 14 次修订只保留最近 10 个版本（版本上限），最新永远保留且单调唯一
		assert.equal(versions.length, 10);
		assert.deepEqual(versions, Array.from({ length: 10 }, (_, index) => index + 5));
	});
	check("Version cap keeps the newest revisions only", () => {
		const kept = listWorkflowDefinitions(root, true)
			.filter(item => item.id === created.id)
			.map(item => item.version)
			.sort((a, b) => a - b);
		assert.equal(kept.at(-1), 14, "latest version always retained");
		assert.equal(kept[0], 5, "oldest versions beyond the cap are dropped");
	});
	check("Workflow delete removes all versions", () => {
		deleteWorkflowDefinition(root, created.id);
		assert.equal(getWorkflowDefinition(root, created.id), undefined);
		assert.equal(listWorkflowDefinitions(root, true).some(item => item.id === created.id), false);
	});
	check("Workflow delete rejects a running definition", () => {
		const another = createWorkflowDefinition(root, { name: "running-wf", dag: firstDag });
		assert.throws(
			() => deleteWorkflowDefinition(root, "running-wf", new Set(["running-wf"])),
			/cannot be deleted/,
		);
		assert.throws(() => deleteWorkflowDefinition(root, "no-such-wf"), /Workflow not found/);
	});
	console.log(`\n${passed} workflow registry checks passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
