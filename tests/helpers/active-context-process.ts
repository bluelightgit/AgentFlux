import { registerActiveContext, releaseActiveContext } from "../../src/core/active-context";

const [root, context, name, holdText, mode = "normal"] = process.argv.slice(2);
const holdMs = Math.max(50, Number(holdText ?? 250));
if (!root || !name || !["main", "workflow", "community"].includes(context) || !["normal", "crash"].includes(mode)) {
	console.error("usage: active-context-process <root> <context> <name> [holdMs] [normal|crash]");
	process.exit(2);
}
try {
	const lease = registerActiveContext(root, { name, context: context as "main" | "workflow" | "community", scope: name, task: `process ${name}` });
	console.log(JSON.stringify({ ok: true, leaseId: lease.leaseId, mode }));
	setTimeout(() => {
		if (mode === "crash") {
			// Abruptly terminate the real helper after the lease is durable; no release runs.
			process.abort();
			return;
		}
		try { releaseActiveContext(root, lease.leaseId); } catch (error) { console.error(error); process.exitCode = 1; }
	}, holdMs);
} catch (error) {
	console.log(JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error) }));
	process.exitCode = 1;
}
