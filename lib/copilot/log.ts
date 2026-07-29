/**
 * Lightweight structured logging for copilot turns / executions.
 * Logs to stdout (picked up by Next.js / hosting). Never logs secrets.
 */

function trunc(v: unknown, n = 12): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length > n ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

export function logCopilotEvent(
  event: string,
  payload: Record<string, unknown> = {},
): void {
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
  // eslint-disable-next-line no-console
  console.log("[copilot]", JSON.stringify(safe));
}
