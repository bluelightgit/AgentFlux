/** Zero-cost lifecycle fixture: first process fails, retry emits a valid RPC dialog then exits 0. */
import { existsSync, writeFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function retryLifecycleSmoke(pi: ExtensionAPI): void {
  pi.on('session_start', async (_event, ctx) => {
    const flag = process.env.AGENTFLUX_RETRY_SMOKE_FLAG;
    if (!flag) return;
    if (!existsSync(flag)) {
      writeFileSync(flag, 'failed-once', 'utf8');
      process.exit(23);
      return;
    }
    await ctx.ui.confirm('Retry lifecycle smoke', 'Acknowledge the zero-cost retry.');
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.exit(0);
  });
}
