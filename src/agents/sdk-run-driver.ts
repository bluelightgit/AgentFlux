import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiSdkHostBinding } from "../core/pi-sdk";
import type { SdkRunOwner } from "../core/runtime-owner";
import type { EffectiveCapabilityPolicy } from "../core/capability-policy";
import { registerSubagentSafety, type SubagentSafetyControl } from "../subagent-entry";

export interface SdkRunDriverOptions {
	binding: PiSdkHostBinding;
	owner: SdkRunOwner;
	controlCwd: string;
	cwd: string;
	runId: string;
	agentName: string;
	instanceId: string;
	role: string;
	taskId?: string;
	model: string;
	provider?: string;
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	appendSystemPrompt: string;
	capability: EffectiveCapabilityPolicy;
	lockFiles: string[];
	startupMessageIds: string[];
	persistent: boolean;
	sessionId?: string;
	sessionFile?: string;
	sessionDir: string;
	signal?: AbortSignal;
}

/** Only the transport/lifecycle adapter. Budget, Message V2 and terminal state stay in Core Runner. */
export class SdkRunDriver extends EventEmitter {
	readonly backend = "sdk" as const;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	private started = false;
	private abortRequested = false;
	private closed = false;
	private work?: Promise<void>;
	private unsubscribe: () => void;
	constructor(private readonly session: AgentSession, private readonly safety: SubagentSafetyControl) {
		super();
		this.sessionId = session.sessionManager.getSessionId();
		this.sessionFile = session.sessionManager.getSessionFile();
		this.unsubscribe = session.subscribe(event => {
			// Typed SDK events keep their native fields; expose the JSON-compatible
			// provisional snapshot consumed by the existing Runner accounting adapter.
			const message = (event as any).message;
			const value = event.type === "message_update" ? { ...event, usage: message?.usage ?? (event as any).usage } : event;
			this.emit("event", value);
		});
	}
	start(task: string): void {
		if (this.started) throw new Error("SDK driver already started");
		this.started = true;
		this.work = this.execute(task);
	}
	async abort(): Promise<boolean> {
		if (this.closed) return true;
		this.abortRequested = true;
		this.safety.closeInput();
		this.session.clearQueue();
		await this.session.abort();
		return true;
	}
	private async execute(task: string): Promise<void> {
		let code = 0;
		try {
			if (this.abortRequested) code = 130;
			else {
				await this.session.prompt(task, { expandPromptTemplates: false });
				// A settled hook may have queued an independent Message V2 turn.
				// Drain accepted work, then synchronously close the input fence.
				do {
					await this.session.waitForIdle();
					await new Promise<void>(done => setImmediate(done));
				} while (!this.abortRequested && (this.session.isStreaming || this.safety.hasPendingInput() || this.session.getSteeringMessages().length > 0 || this.session.getFollowUpMessages().length > 0));
			}
		} catch (error) {
			code = this.abortRequested ? 130 : 1;
			this.emit("error", error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.safety.closeInput();
			// dispose() does not await idle. Never report close or release logical
			// ownership while a provider/tool may still be running in Main.
			try {
				await this.session.abort();
				await this.session.waitForIdle();
				this.safety.shutdown();
				this.unsubscribe();
				this.session.dispose();
				this.closed = true;
				this.emit("close", code, null);
			} catch (error) {
				// Cleanup failure is not exit evidence and must not become an
				// unhandled rejection that terminates Main. Core retains ownership.
				this.emit("error", new Error(`SDK shutdown did not prove idle/disposal: ${String(error)}`));
			}
		}
	}
	get hasExited(): boolean { return this.closed; }
	getEntries() { return this.session.sessionManager.getEntries(); }
}

export async function createSdkRunDriver(options: SdkRunDriverOptions): Promise<SdkRunDriver> {
	const { sdk, modelRegistry: parentRegistry } = options.binding;
	const candidates = parentRegistry.getModelsOfType("chat").filter(item => item.id === options.model && (!options.provider || item.provider === options.provider));
	if (candidates.length !== 1) throw new Error(`Unknown or ambiguous SDK chat model: ${options.provider ?? ""}/${options.model}`);
	const selected = candidates[0];
	if (selected.api === "pi-virtual") throw new Error(`Virtual models are not supported by this SDK driver: ${selected.provider}/${selected.id}`);
	const modelRuntime = await sdk.ModelRuntime.create({ allowModelNetwork: false, signal: options.signal });
	// Copy only the selected provider's public registration, never mutate Main's
	// registry or inspect private runtime fields. Disk-configured auth stays native.
	const providerConfig = parentRegistry.getRegisteredProviderConfig(selected.provider);
	const nativeProvider = parentRegistry.getRegisteredNativeProvider(selected.provider);
	if (providerConfig) modelRuntime.registerProvider(selected.provider, providerConfig);
	if (nativeProvider) modelRuntime.registerNativeProvider(nativeProvider);
	const model = modelRuntime.getModel(selected.provider, selected.id);
	if (!model) throw new Error(`SDK provider implementation is unavailable: ${selected.provider}/${selected.id}`);
	if (!modelRuntime.hasConfiguredAuth(selected.provider)) throw new Error(`SDK provider authentication is unavailable: ${selected.provider}`);
	const privateDir = join(options.controlCwd, ".agentflux", "runtime", "sdk-resources", options.runId);
	mkdirSync(privateDir, { recursive: true });
	const settingsManager = sdk.SettingsManager.inMemory({
		...options.binding.settings,
		packages: [], extensions: [], skills: [], prompts: [], themes: [],
		retry: { enabled: false, maxRetries: 0 }, cacheWarming: "off",
	});
	const sessionManager = options.persistent
		? options.sessionFile ? sdk.SessionManager.open(options.sessionFile, options.sessionDir, options.cwd)
			: sdk.SessionManager.create(options.cwd, options.sessionDir, { id: options.sessionId })
		: sdk.SessionManager.inMemory(options.cwd);
	let safety: SubagentSafetyControl | undefined;
	let accepting = true;
	const loader = new sdk.DefaultResourceLoader({
		cwd: options.cwd, agentDir: privateDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalSkillPaths: options.capability.skills.map(path => resolve(options.cwd, path)),
		appendSystemPrompt: options.appendSystemPrompt.trim() ? [options.appendSystemPrompt] : [],
		// No global SYSTEM/APPEND_SYSTEM/context/package discovery, including side-effectful factories.
		systemPromptOverride: () => undefined, appendSystemPromptOverride: () => options.appendSystemPrompt.trim() ? [options.appendSystemPrompt] : [],
		extensionFactories: [pi => {
			safety = registerSubagentSafety(pi, {
				agentName: options.agentName, instanceId: options.instanceId, runId: options.runId, taskId: options.taskId,
				controlCwd: options.controlCwd, agentRole: options.role, rpcInboxEnabled: options.persistent,
				communicationPolicy: options.capability.communication, capabilityPolicy: options.capability,
				lockFiles: options.lockFiles, startupMessageIds: options.startupMessageIds,
				runtimeOwner: options.owner, isRunAccepting: () => accepting,
			});
		}],
	});
	await loader.reload();
	if (loader.getExtensions().errors.length > 0) throw new Error(`SDK safety extension failed: ${JSON.stringify(loader.getExtensions().errors)}`);
	const resources = loader.getSkills();
	if (resources.diagnostics.some(item => item.type === "error")) throw new Error(`SDK skill loading failed: ${JSON.stringify(resources.diagnostics)}`);
	let session: AgentSession | undefined;
	try {
		const created = await sdk.createAgentSession({ cwd: options.cwd, agentDir: privateDir, modelRuntime, model, thinkingLevel: options.thinking,
			settingsManager, sessionManager, resourceLoader: loader, tools: [...options.capability.tools] });
		session = created.session;
		if (created.modelFallbackMessage) throw new Error(`SDK model restoration refused: ${created.modelFallbackMessage}`);
		if (!safety) throw new Error("SDK safety extension was not initialized");
		const enabled = new Set(session.getActiveToolNames());
		if (options.capability.tools.some(name => !enabled.has(name))) throw new Error(`SDK requested tools were not registered: ${options.capability.tools.filter(name => !enabled.has(name)).join(", ")}`);
		await session.bindExtensions({ mode: "json" });
		if (safety.initializationError()) throw new Error(`SDK safety startup failed: ${safety.initializationError()}`);
		return new SdkRunDriver(session, safety);
	} catch (error) {
		accepting = false;
		safety?.closeInput();
		if (session) { await session.abort(); await session.waitForIdle(); session.dispose(); }
		safety?.shutdown();
		throw error;
	}
}
