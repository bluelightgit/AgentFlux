import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runAgentFluxTeam, type AgentFluxTeamSpec } from "../src/host/index";

const [cwdArg, specArg] = process.argv.slice(2);
if (!cwdArg || !specArg) {
	console.error("Usage: npm run dispatch:team -- <agentflux-cwd> <team-spec.json>");
	process.exit(2);
}

const cwd = resolve(cwdArg);
const spec = JSON.parse(readFileSync(resolve(specArg), "utf-8")) as AgentFluxTeamSpec;
const result = await runAgentFluxTeam(cwd, spec);
console.log(JSON.stringify(result, null, 2));
if (!result.allSucceeded) process.exitCode = 1;
