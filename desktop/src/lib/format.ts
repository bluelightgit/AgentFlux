/**
 * Shared formatting utilities for the AgentFlux Desktop app.
 * All components should import from here — no local format function definitions.
 */

/** Format a token count with k/M suffixes. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

/** Format a cost in USD with adaptive precision. */
export function formatCost(c: number): string {
  if (c === 0) return "$0";
  if (c < 0.001) return `$${c.toExponential(2)}`;
  if (c < 0.01) return `$${c.toFixed(6)}`;
  if (c < 1) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}

/** Format a 0..1 ratio as a percentage string. */
export function formatPct(r: number): string {
  if (!isFinite(r) || r <= 0) return "0%";
  return `${(r * 100).toFixed(1)}%`;
}

/** Format a timestamp (ms epoch) as a locale string. */
export function formatTs(ts: number): string {
  if (!ts) return "-";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "-";
  }
}

/** Format a timestamp (ms epoch) as time only (HH:MM). */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

/** Format a plain number with k suffix for thousands. */
export function formatNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}
