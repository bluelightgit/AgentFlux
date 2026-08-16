import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJsonStore, updateJsonStore } from "../core/json-store";
import type { TaskDAG } from "./dag-executor";

export interface WorkflowDefinition {
	id: string;
	name: string;
	version: number;
	description: string;
	dag: TaskDAG;
	sourceTaskId?: string;
	createdAt: string;
	updatedAt: string;
}

interface WorkflowStore {
	version: 1;
	definitions: WorkflowDefinition[];
}

function storePath(fluxDir: string): string {
	return join(fluxDir, "runtime", "workflows.json");
}
/** 每个 workflow 保留的最近版本数上限（超出移除最旧版本，最新永远保留）。 */
const MAX_VERSIONS_PER_WORKFLOW = 10;

const createStore = (): WorkflowStore => ({ version: 1, definitions: [] });
const isStore = (value: unknown): value is WorkflowStore =>
	!!value && typeof value === "object"
	&& (value as WorkflowStore).version === 1
	&& Array.isArray((value as WorkflowStore).definitions);

function readStore(fluxDir: string): WorkflowStore {
	return readJsonStore(storePath(fluxDir), createStore, isStore);
}

function updateStore<R>(fluxDir: string, update: (store: WorkflowStore) => R): R {
	return updateJsonStore(storePath(fluxDir), createStore, isStore, update);
}

function parseSelector(selector: string): { identity: string; version?: number } {
	const match = selector.trim().match(/^(.*)@(\d+)$/);
	return match ? { identity: match[1], version: Number(match[2]) } : { identity: selector.trim() };
}

function findDefinition(store: WorkflowStore, selector: string): WorkflowDefinition | undefined {
	const { identity, version } = parseSelector(selector);
	return store.definitions
		.filter(definition => definition.id === identity || definition.name === identity)
		.filter(definition => version === undefined || definition.version === version)
		.sort((a, b) => b.version - a.version)[0];
}

export function listWorkflowDefinitions(fluxDir: string, includeVersions = false): WorkflowDefinition[] {
	const definitions = readStore(fluxDir).definitions;
	if (includeVersions) {
		return definitions.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
	const latest = new Map<string, WorkflowDefinition>();
	for (const definition of definitions) {
		const current = latest.get(definition.id);
		if (!current || definition.version > current.version) latest.set(definition.id, definition);
	}
	return [...latest.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 删除保存的 Workflow 定义（含全部版本）；运行中的定义拒绝删除。 */
export function deleteWorkflowDefinition(fluxDir: string, selector: string, activeSelectors: ReadonlySet<string> = new Set()): WorkflowDefinition {
	let removed: WorkflowDefinition | undefined;
	updateStore(fluxDir, store => {
		const target = findDefinition(store, selector);
		if (!target) throw new Error(`Workflow not found: ${selector}`);
		if (activeSelectors.has(target.name) || activeSelectors.has(target.id)) {
			throw new Error(`Workflow is currently running and cannot be deleted: ${target.name}`);
		}
		const kept = store.definitions.filter(definition => definition.id !== target.id);
		if (kept.length === store.definitions.length) throw new Error(`Workflow not found: ${selector}`);
		removed = target;
		store.definitions = kept;
	});
	return removed!;
}

export function getWorkflowDefinition(fluxDir: string, selector: string): WorkflowDefinition | undefined {
	return findDefinition(readStore(fluxDir), selector);
}

export function createWorkflowDefinition(
	fluxDir: string,
	input: { name: string; dag: TaskDAG; sourceTaskId?: string },
): WorkflowDefinition {
	const name = input.name.trim();
	if (!name) throw new Error("Workflow name cannot be empty");
	const now = new Date().toISOString();
	const definition: WorkflowDefinition = {
		id: `workflow-${randomUUID()}`,
		name,
		version: 1,
		description: input.dag.description,
		dag: structuredClone(input.dag),
		sourceTaskId: input.sourceTaskId,
		createdAt: now,
		updatedAt: now,
	};
	return updateStore(fluxDir, store => {
		if (store.definitions.some(item => item.name === name)) {
			throw new Error(`Workflow name already exists: ${name}`);
		}
		store.definitions.push(definition);
		return definition;
	});
}

export function reviseWorkflowDefinition(
	fluxDir: string,
	selector: string,
	input: { dag: TaskDAG; sourceTaskId?: string; name?: string },
): WorkflowDefinition {
	return updateStore(fluxDir, store => {
		const previous = findDefinition(store, selector);
		if (!previous) throw new Error(`Workflow not found: ${selector}`);
		const name = input.name?.trim() || previous.name;
		if (store.definitions.some(definition => definition.id !== previous.id && definition.name === name)) {
			throw new Error(`Workflow name already exists: ${name}`);
		}
		const definition: WorkflowDefinition = {
			id: previous.id,
			name,
			version: Math.max(...store.definitions.filter(item => item.id === previous.id).map(item => item.version)) + 1,
			description: input.dag.description,
			dag: structuredClone(input.dag),
			sourceTaskId: input.sourceTaskId,
			createdAt: previous.createdAt,
			updatedAt: new Date().toISOString(),
		};
		store.definitions.push(definition);
		// 版本保留上限：只保留最近 MAX_VERSIONS_PER_WORKFLOW 个版本，最旧版本直接移除
		// （与 Agent GC keepLatestK 同一语义；最新版本永远保留）
		const history = store.definitions.filter(item => item.id === previous.id)
			.sort((a, b) => b.version - a.version);
		for (const stale of history.slice(MAX_VERSIONS_PER_WORKFLOW)) {
			const index = store.definitions.indexOf(stale);
			if (index !== -1) store.definitions.splice(index, 1);
		}
		return definition;
	});
}

export function formatWorkflowDefinitions(definitions: WorkflowDefinition[], detailed = false): string {
	if (definitions.length === 0) return "No saved Workflows.";
	if (!detailed) {
		return ["Saved Workflows:", ...definitions.map(definition =>
			`  ${definition.id}@${definition.version} · ${definition.name} · ${definition.dag.nodes.length} nodes\n    ${definition.description.slice(0, 160)}`,
		)].join("\n");
	}
	return definitions.map(definition => [
		`${definition.id}@${definition.version} · ${definition.name}`,
		definition.description,
		...definition.dag.nodes.map(node =>
			`  ${node.id} · ${node.role} · depends on ${node.dependsOn.join(", ") || "-"} · ${node.title}`,
		),
	].join("\n")).join("\n\n");
}
