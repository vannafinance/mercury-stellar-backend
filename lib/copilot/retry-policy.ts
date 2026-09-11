/**
 * One retry policy per operation class. Scattered retries (scope once,
 * audit-script ECONNRESET, read deadlines, nothing on simulateTransaction)
 * are how a dropped Soroban socket became an unhandled EPIPE.
 *
 * Writes are not retried here. A second submit can move money twice.
 * Footprint-race resubmit (`withFootprintRaceRetry` in stellar-utils) stays
 * the write-side exception because it is a known ledger-lag shape, not a
 * generic network blip.
 */

export type RetryPolicy = {
  /** Total tries, including the first. */
  attempts: number;
  backoffMs: readonly number[];
  retryable: readonly string[];
  onExhaustion: "throw";
};

export const RETRY = {
  /** Soroban/Horizon reads (simulateTransaction, getLatestLedger, snapshots). */
  rpcRead: {
    attempts: 2,
    backoffMs: [200],
    retryable: [
      "ECONNRESET",
      "EPIPE",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "fetch failed",
      "failed to fetch",
      "network",
      "socket hang up",
    ],
    onExhaustion: "throw",
  },
  /** MCP tool reads. Stale-session replay stays in mcp-client. */
  mcpRead: {
    attempts: 2,
    backoffMs: [300],
    retryable: [
      "ECONNRESET",
      "EPIPE",
      "ETIMEDOUT",
      "fetch failed",
      "failed to fetch",
      "network",
      "socket hang up",
    ],
    onExhaustion: "throw",
  },
  /** MCP / Sign Service writes — never retry from this policy. */
  mcpWrite: {
    attempts: 1,
    backoffMs: [],
    retryable: [],
    onExhaustion: "throw",
  },
  /** Wallet bindings + account resolve ahead of the investigation loop. */
  scope: {
    attempts: 2,
    backoffMs: [200],
    retryable: [
      "ECONNRESET",
      "EPIPE",
      "ETIMEDOUT",
      "fetch failed",
      "failed to fetch",
      "network",
    ],
    onExhaustion: "throw",
  },
} as const satisfies Record<string, RetryPolicy>;

export type RetryClass = keyof typeof RETRY;

function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);
  const code = "code" in error && error.code != null ? String(error.code) : "";
  const cause = "cause" in error && error.cause != null ? errorText(error.cause) : "";
  const message = error instanceof Error ? error.message : String(error);
  return `${code} ${message} ${cause}`;
}

export function isRetryableError(error: unknown, policy: RetryPolicy): boolean {
  if (policy.attempts <= 1 || policy.retryable.length === 0) return false;
  // Axios "Network Error", browser "Failed to fetch", Node "fetch failed".
  const text = errorText(error).toLowerCase();
  return policy.retryable.some((token) => text.includes(token.toLowerCase()));
}

export async function withRetry<T>(policy: RetryPolicy, operation: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      const retry = attempt + 1 < policy.attempts && isRetryableError(error, policy);
      if (!retry) throw error;
      const wait = policy.backoffMs[Math.min(attempt, Math.max(0, policy.backoffMs.length - 1))] ?? 0;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw last;
}
