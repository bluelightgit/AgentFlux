import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as hostSdk from "@earendil-works/pi-coding-agent";
import agentFlux from "./entry.js";

// Deliberately retain .ts in the package: Pi's public loader applies its Host
// virtual-module mapping here; native compiled ESM can bypass that mapping.
// The generated entry.js remains the single bundled business implementation.
export default function (pi: ExtensionAPI) { return agentFlux(pi, hostSdk); }
