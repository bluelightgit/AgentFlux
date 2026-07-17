import React, { useEffect, useMemo, useState } from 'react';
import { agentRuntimeClient } from '../lib/agent-runtime';
import { createCapabilitySetRequest, type CapabilityPolicyView } from '../lib/capability-policy';
import { Icon } from './ui';

const LAYER_STYLE = {
  template: 'border-sky-400/50 bg-sky-400/10 text-sky-700 dark:text-sky-300',
  registered: 'border-amber-400/50 bg-amber-400/10 text-amber-700 dark:text-amber-300',
  run: 'border-rose-400/50 bg-rose-400/10 text-rose-700 dark:text-rose-300',
} as const;

function ItemList({ values, empty = 'none' }: { values: string[]; empty?: string }): React.ReactElement {
  return values.length ? (
    <div className="flex flex-wrap gap-1">{values.map((value) => (
      <code key={value} className="rounded border border-slate-300/70 bg-white/80 px-1.5 py-0.5 text-[10px] text-slate-700 dark:border-slate-600 dark:bg-slate-950/60 dark:text-slate-200">{value}</code>
    ))}</div>
  ) : <span className="text-xs italic text-slate-400">{empty}</span>;
}

export function CapabilityPolicyPanel({ projectRoot, agentName }: { projectRoot: string; agentName?: string }): React.ReactElement {
  const [view, setView] = useState<CapabilityPolicyView | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!agentName) { setView(null); return; }
    const loadPolicies = agentRuntimeClient.capabilityPolicies?.bind(agentRuntimeClient);
    if (!loadPolicies) { setView(null); return; }
    void loadPolicies(projectRoot).then((bundle) => {
      if (!alive) return;
      const next = bundle.records.find((record) => record.effective.agentName === agentName) ?? null;
      setView(next);
      setNotices(bundle.notices);
      setDraft(next ? JSON.stringify(createCapabilitySetRequest(next), null, 2) : '');
    }).catch((error: unknown) => {
      if (alive) setNotices([`Capability policy could not be loaded: ${error instanceof Error ? error.message : String(error)}`]);
    });
    return () => { alive = false; };
  }, [agentName, projectRoot]);

  const draftState = useMemo(() => {
    if (!view || !draft) return { valid: false, message: 'No policy request.' };
    try {
      const parsed = JSON.parse(draft) as Record<string, unknown>;
      const valid = parsed.action === 'set' && parsed.agentName === view.effective.agentName
        && parsed.role === view.effective.role && parsed.expectedRevision === (view.registered?.revision ?? 0)
        && parsed.override != null && typeof parsed.override === 'object' && !Array.isArray(parsed.override);
      return valid
        ? { valid: true, message: 'Envelope and revision are valid. Core will enforce narrowing and cache impact.' }
        : { valid: false, message: 'Keep action, identity, role and expectedRevision unchanged; override must be an object.' };
    } catch { return { valid: false, message: 'Draft is not valid JSON.' }; }
  }, [draft, view]);

  if (!agentName) return <></>;
  if (!view) return (
    <section className="border-b border-slate-200 bg-slate-50/70 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-400">
      <div className="flex items-center gap-2"><Icon name="Shield" size={14} /> No effective capability snapshot for <code>{agentName}</code>.</div>
      {notices.map((notice) => <div key={notice} className="mt-1 text-amber-600 dark:text-amber-400">{notice}</div>)}
    </section>
  );

  const policy = view.effective;
  const communication = policy.effective.communication;
  const actions = Array.isArray(communication.actions) ? communication.actions.map(String) : [];
  const targets = Array.isArray(communication.allowedTargets) ? communication.allowedTargets.map(String) : [];
  return (
    <section className="border-b border-slate-200 bg-[linear-gradient(135deg,rgba(15,23,42,.035),transparent_55%)] px-3 py-2 dark:border-slate-700 dark:bg-slate-900/50" aria-label="Effective capability policy">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="flex w-full items-center gap-2 text-left">
        <span className="rounded-sm bg-slate-900 p-1 text-lime-300 dark:bg-lime-300 dark:text-slate-950"><Icon name="ShieldCheck" size={13} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-800 dark:text-slate-100">
            Effective policy <span className="normal-case tracking-normal text-slate-400">{policy.role}</span>
          </div>
          <div className="mt-0.5 truncate text-[10px] text-slate-400">{policy.runId} · {policy.effective.workspace.enforcement}</div>
        </div>
        {policy.narrowed.map((item) => <span key={item} className={`hidden rounded border px-1 py-0.5 text-[9px] lg:inline ${LAYER_STYLE[item.split(':')[0] as keyof typeof LAYER_STYLE] ?? LAYER_STYLE.run}`}>{item}</span>)}
        <Icon name={expanded ? 'ChevronUp' : 'ChevronDown'} size={14} className="text-slate-400" />
      </button>
      {expanded && <div className="mt-3 space-y-3 border-l-2 border-slate-900/80 pl-3 dark:border-lime-300/70">
        <div className="grid gap-2 sm:grid-cols-3">
          <div><div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">Tools</div><ItemList values={policy.effective.tools} /></div>
          <div><div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">Skills</div><ItemList values={policy.effective.skills} /></div>
          <div><div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">MCP · fail closed</div><ItemList values={policy.effective.mcpServers} /></div>
        </div>
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <div className="rounded border border-slate-200 bg-white/70 p-2 dark:border-slate-700 dark:bg-slate-950/40">
            <div className="font-semibold text-slate-700 dark:text-slate-200">Communication · {communication.enabled === false ? 'disabled' : 'enabled'}</div>
            <div className="mt-1 text-slate-500">actions: {actions.join(', ') || 'none'}</div><div className="text-slate-500">targets: {targets.join(', ') || 'none'}</div>
          </div>
          <div className="rounded border border-slate-200 bg-white/70 p-2 dark:border-slate-700 dark:bg-slate-950/40">
            <div className="font-semibold text-slate-700 dark:text-slate-200">Workspace · dangerous commands {policy.effective.workspace.blockDangerousCommands ? 'blocked' : 'allowed'}</div>
            <div className="mt-1 truncate text-slate-500" title={policy.effective.workspace.roots.join(', ')}>roots: {policy.effective.workspace.roots.join(', ')}</div>
            <div className="truncate text-slate-500" title={policy.effective.workspace.deniedPaths.join(', ')}>denied: {policy.effective.workspace.deniedPaths.join(', ') || 'none'}</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">{policy.provenance.map((entry, index) => (
          <span key={`${entry.field}-${entry.sourceLayer}-${index}`} title={entry.reason} className={`rounded border px-1.5 py-0.5 text-[10px] ${LAYER_STYLE[entry.sourceLayer]}`}>{entry.field} ← {entry.sourceLayer}</span>
        ))}</div>
        <details>
          <summary className="cursor-pointer text-xs font-medium text-slate-600 dark:text-slate-300">Registered override request · revision {view.registered?.revision ?? 0}</summary>
          <textarea aria-label="Capability override request" value={draft} onChange={(event) => { setDraft(event.target.value); setCopied(false); }} rows={9} className="mt-2 w-full rounded border border-slate-300 bg-slate-950 p-2 font-mono text-[11px] text-lime-200 outline-none focus:ring-2 focus:ring-lime-400 dark:border-slate-600" />
          <div className="mt-1 flex items-center gap-2">
            <span className={`text-[10px] ${draftState.valid ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{draftState.message}</span>
            <button type="button" disabled={!draftState.valid} onClick={() => { void navigator.clipboard?.writeText(draft); setCopied(true); }} className="ml-auto rounded border border-slate-300 px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800">{copied ? 'Copied' : 'Copy request'}</button>
          </div>
        </details>
      </div>}
    </section>
  );
}
