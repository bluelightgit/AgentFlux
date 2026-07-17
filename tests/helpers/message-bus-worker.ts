import { MessageBus } from "../../src/core/message-bus";

const [fluxDir, prefix] = process.argv.slice(2);
if (!fluxDir || !prefix) throw new Error("usage: message-bus-worker <fluxDir> <prefix>");
const bus = new MessageBus(fluxDir);
for (let index = 0; index < 10; index++) {
	bus.sendDirect(prefix, "concurrent", "concurrency", `${prefix}-${index}`, {
		dedupeKey: `${prefix}-${index}`,
	});
}
