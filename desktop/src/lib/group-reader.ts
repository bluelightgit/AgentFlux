/**
 * Group chat data layer for multi-agent collaboration.
 *
 * Reads the AgentFlux shared board files:
 *   - groups registry:    <fluxDir>/shared/groups/_registry.json
 *   - group messages:     <fluxDir>/shared/groups/{groupId}/messages.jsonl
 *
 * All reads go through the Electron preload bridge (file-access.ts) and
 * gracefully degrade to empty arrays when files are missing or malformed.
 */

import { readFileContent } from "./file-access";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GroupType = "all" | "team" | "direct";

export interface AgentGroup {
  id: string;
  name: string;
  type: GroupType;
  members: string[];
  created: number;
  createdBy?: string;
  description?: string;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  from: string;
  content: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Direct (1-on-1) message types
// ---------------------------------------------------------------------------

export type DirectMessageType = "text" | "notice" | "system";

export interface DirectMessage {
  id: string;
  from: string;
  to: string;
  type: DirectMessageType;
  content: string;
  timestamp: number;
  read: boolean;
}

// ---------------------------------------------------------------------------
// Agent registry types
// ---------------------------------------------------------------------------

export type AgentRegistryStatus =
  | "running"
  | "done"
  | "failed"
  | "blocked"
  | "idle";

export interface AgentInfo {
  name: string;
  role: string;
  status: AgentRegistryStatus;
  currentTask?: string;
  model?: string | null;
  thinking?: string | null;
  lastSeen?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupsRoot(fluxDir: string): string {
  return `${fluxDir}/shared/groups`;
}

/** Parse a JSON value, returning null on failure. */
function safeParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List all registered agent groups. */
export async function listGroups(fluxDir: string): Promise<AgentGroup[]> {
  const registryPath = `${groupsRoot(fluxDir)}/_registry.json`;
  const content = await readFileContent(registryPath);
  if (!content) return [];
  const parsed = safeParse(content);
  if (!Array.isArray(parsed)) return [];

  const groups: AgentGroup[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.id ?? "");
    if (!id) continue;
    groups.push({
      id,
      name: String(entry.name ?? id),
      type: (entry.type as GroupType) ?? "team",
      members: Array.isArray(entry.members)
        ? entry.members.map((m: any) => String(m))
        : [],
      created: Number(entry.created) || 0,
      createdBy: entry.createdBy != null ? String(entry.createdBy) : undefined,
      description:
        entry.description != null ? String(entry.description) : undefined,
    });
  }
  return groups.sort((a, b) => a.created - b.created);
}

/** Read the message stream for a single group. */
export async function getGroupMessages(
  fluxDir: string,
  groupId: string,
): Promise<GroupMessage[]> {
  const messagesPath = `${groupsRoot(fluxDir)}/${groupId}/messages.jsonl`;
  const content = await readFileContent(messagesPath);
  if (!content) return [];

  const messages: GroupMessage[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = safeParse(trimmed);
    if (!entry || typeof entry !== "object") continue;
    messages.push({
      id: String(entry.id ?? ""),
      groupId: String(entry.groupId ?? groupId),
      from: String(entry.from ?? ""),
      content: String(entry.content ?? ""),
      timestamp: Number(entry.timestamp) || 0,
    });
  }
  return messages.sort((a, b) => a.timestamp - b.timestamp);
}

// ---------------------------------------------------------------------------
// Direct (1-on-1) messages
// ---------------------------------------------------------------------------

/** Direct messages stream path: <fluxDir>/shared/direct/messages.jsonl */
function directMessagesPath(fluxDir: string): string {
  return `${fluxDir}/shared/direct/messages.jsonl`;
}

/** Coerce a raw direct-message entry's type into a known DirectMessageType. */
function toDirectMessageType(raw: unknown): DirectMessageType {
  switch (raw) {
    case "text":
    case "notice":
    case "system":
      return raw;
    default:
      return "text";
  }
}

/**
 * Read the shared direct-message stream.
 *
 * Reads `<fluxDir>/shared/direct/messages.jsonl` (one JSON object per line,
 * each carrying `from`, `to`, `type`, `content`, `timestamp`, and `read`
 * fields) through the Electron preload bridge and gracefully returns an
 * empty array when the file is missing or malformed.
 */
export async function getDirectMessages(
  fluxDir: string,
): Promise<DirectMessage[]> {
  const content = await readFileContent(directMessagesPath(fluxDir));
  if (!content) return [];

  const messages: DirectMessage[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = safeParse(trimmed);
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.id ?? "");
    const from = String(entry.from ?? "");
    const to = String(entry.to ?? "");
    if (!from || !to) continue;
    messages.push({
      id,
      from,
      to,
      type: toDirectMessageType(entry.type),
      content: String(entry.content ?? ""),
      timestamp: Number(entry.timestamp) || 0,
      read: Boolean(entry.read),
    });
  }
  return messages.sort((a, b) => a.timestamp - b.timestamp);
}

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

/** Shared agents registry path: <fluxDir>/shared/agents/_registry.json */
function agentsRegistryPath(fluxDir: string): string {
  return `${fluxDir}/shared/agents/_registry.json`;
}

/** Coerce a raw registry entry status into a known AgentRegistryStatus. */
function toAgentStatus(raw: unknown): AgentRegistryStatus {
  switch (raw) {
    case "running":
    case "done":
    case "failed":
    case "blocked":
    case "idle":
      return raw;
    default:
      return "idle";
  }
}

/**
 * List all agents registered in the shared agent registry.
 *
 * Reads `<fluxDir>/shared/agents/_registry.json` (an array of agent
 * descriptors) through the Electron preload bridge and gracefully returns
 * an empty array when the file is missing or malformed.
 */
export async function listAgents(fluxDir: string): Promise<AgentInfo[]> {
  const content = await readFileContent(agentsRegistryPath(fluxDir));
  if (!content) return [];
  const parsed = safeParse(content);
  if (!Array.isArray(parsed)) return [];

  const agents: AgentInfo[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const name = String(entry.name ?? "");
    if (!name) continue;
    agents.push({
      name,
      role: String(entry.role ?? ""),
      status: toAgentStatus(entry.status),
      currentTask:
        entry.currentTask != null ? String(entry.currentTask) : undefined,
      model: entry.model != null ? String(entry.model) : null,
      thinking: entry.thinking != null ? String(entry.thinking) : null,
      lastSeen: entry.lastSeen != null ? String(entry.lastSeen) : null,
    });
  }
  return agents;
}
