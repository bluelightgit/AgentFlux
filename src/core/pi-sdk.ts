import type * as Pi from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { resolvePiInvocation, type PiRuntimeProvenance } from "./pi-runtime";

export type PiSdkFacade = typeof Pi;
export type PiSdkSettings = ReturnType<Pi.ExtensionAPI["getSettings"]>;
export interface PiSdkHostBinding {
	readonly sdk: PiSdkFacade;
	readonly modelRegistry: Pi.ModelRegistry;
	readonly settings: PiSdkSettings;
	readonly invocation: PiRuntimeProvenance;
	readonly token: object;
}
const hosts = new Map<string, PiSdkHostBinding>();

/** Host wrapper注入真实公共SDK；类身份必须与当前Main session/registry相同。 */
export function bindPiSdkHost(cwd: string, sdk: PiSdkFacade, context: Pick<Pi.ExtensionContext, "sessionManager" | "modelRegistry">, settings: PiSdkSettings): PiSdkHostBinding {
	if (!(context.sessionManager instanceof sdk.SessionManager) || !(context.modelRegistry instanceof sdk.ModelRegistry)) {
		throw new Error("Pi SDK module identity does not match the Main session and model registry");
	}
	const invocation = resolvePiInvocation({ hostPackageDir: sdk.getPackageDir(), hostVersion: sdk.VERSION }).provenance;
	const previous = hosts.get(resolve(cwd));
	if (previous && previous.sdk.SessionManager !== sdk.SessionManager) throw new Error("A different Pi SDK is already bound to this project");
	const binding: PiSdkHostBinding = Object.freeze({ sdk, modelRegistry: context.modelRegistry, settings: structuredClone(settings), invocation, token: {} });
	hosts.set(resolve(cwd), binding);
	return binding;
}

export function getPiSdkHost(cwd: string): PiSdkHostBinding | undefined { return hosts.get(resolve(cwd)); }
export function requirePiSdkHost(cwd: string): PiSdkHostBinding {
	const binding = getPiSdkHost(cwd);
	if (!binding) throw new Error("SDK subagents require a module-identity-verified Main Pi host; reload or restart the extension");
	// Re-read installation metadata: an updated active Host must not start work with a new installation.
	resolvePiInvocation({ hostPackageDir: binding.sdk.getPackageDir(), hostVersion: binding.sdk.VERSION });
	return binding;
}
export function releasePiSdkHost(cwd: string, binding: PiSdkHostBinding | undefined): void {
	if (binding && hosts.get(resolve(cwd))?.token === binding.token) hosts.delete(resolve(cwd));
}
