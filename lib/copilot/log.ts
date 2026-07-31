/**
 * Lightweight structured logging for copilot turns / executions.
 * Logs to stdout (picked up by Next.js / hosting). Never logs secrets.
 */

function trunc(v: unknown, n = 12): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length > n ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

/**
 * Per-turn events are opt-in via COPILOT_LOG so a dev terminal stays readable.
 * Errors and warnings elsewhere are never gated — only this routine chatter is.
 * Anything that sets an explicit log level (hosting, CI) keeps the full stream.
 */
function enabled(): boolean {
  return Boolean(process.env.COPILOT_LOG) || process.env.NODE_ENV === "production";
}

export function logCopilotEvent(
  event: string,
  payload: Record<string, unknown> = {},
): void {
  if (!enabled()) return;
  const safe: Record<string, unknown> = { event, ts: new Date().toISOString() };
  for (const [k, v] of Object.entries(payload)) {
    if (v == null) {
      safe[k] = null;
      continue;
    }
    if (/secret|token|password|authorization/i.test(k)) continue;
    if (k === "wallet" || k === "trader" || k === "smart_account" || k === "hash") {
      safe[k] = trunc(v, 14);
    } else if (typeof v === "string" && v.length > 200) {
      safe[k] = v.slice(0, 200) + "…";
    } else {
      safe[k] = v;
    }
  }
  console.log("[copilot]", JSON.stringify(safe));
}
