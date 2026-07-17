/** Test-only pi extension used by extension-ui-smoke.ts. Never loaded by production Desktop. */
import { writeFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function extensionUiSmoke(pi: ExtensionAPI): void {
  pi.on('session_start', async (_event, ctx) => {
    // RPC startup does not keep a sequential session_start dialog chain alive after the
    // first response, so issue the independent smoke dialogs together.
    const [confirmed, selected, input] = await Promise.all([
      ctx.ui.confirm('Desktop live confirm', 'Allow the controlled smoke test?'),
      ctx.ui.select('Desktop live select', ['alpha', 'beta', 'gamma']),
      ctx.ui.input('Desktop live input', 'type smoke-value'),
    ]);
    const resultPath = process.env.AGENTFLUX_EXTENSION_UI_RESULT;
    if (resultPath) {
      writeFileSync(resultPath, JSON.stringify({ confirmed, selected, input, completedAt: Date.now() }), 'utf8');
    }
  });
}
