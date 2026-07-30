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
