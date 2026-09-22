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
    attempts: 3,
    backoffMs: [250, 600],
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
      "429",
      "502",
      "503",
      "524",
      "rate limit",
      "too many requests",
      "bad gateway",
      "service unavailable",
      "gateway timeout",
    ],
    onExhaustion: "throw",
  },
  /** MCP tool reads. Stale-session replay stays in mcp-client. */
  mcpRead: {
    attempts: 3,
    backoffMs: [300, 700],
    retryable: [
      "ECONNRESET",
      "EPIPE",
      "ETIMEDOUT",
      "fetch failed",
      "failed to fetch",
      "network",
      "socket hang up",
      "429",
      "502",
      "503",
      "524",
      "rate limit",
      "too many requests",
      "bad gateway",
      "service unavailable",
      "gateway timeout",
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
      "429",
      "502",
      "503",
      "524",
      "rate limit",
      "too many requests",
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
  const status = "status" in error && error.status != null ? String(error.status) : "";
  const statusCode = "statusCode" in error && error.statusCode != null ? String(error.statusCode) : "";
  const respStatus =
    "response" in error && typeof error.response === "object" && error.response && "status" in error.response
      ? String((error.response as { status?: unknown }).status)
      : "";
  const cause = "cause" in error && error.cause != null ? errorText(error.cause) : "";
  const message = error instanceof Error ? error.message : String(error);
  return `${code} ${status} ${statusCode} ${respStatus} ${message} ${cause}`;
}

export function isRetryableError(error: unknown, policy: RetryPolicy): boolean {
  if (policy.attempts <= 1 || policy.retryable.length === 0) return false;
  // Axios "Network Error", browser "Failed to fetch", Node "fetch failed", HTTP 429/524.
  const text = errorText(error).toLowerCase();
  return policy.retryable.some((token) => text.includes(token.toLowerCase()));
}

/** Classifies upstream network/RPC failures into clean user diagnostics. */
export function classifyUpstreamError(error: unknown): string | null {
  const text = errorText(error).toLowerCase();
  if (text.includes("429") || text.includes("rate limit") || text.includes("too many requests")) {
    return "Run was inconclusive due to upstream RPC rate-limiting (HTTP 429). Please retry in a moment.";
  }
  if (text.includes("524") || text.includes("gateway timeout") || text.includes("cloudflare")) {
    return "Run was inconclusive due to upstream gateway timeout (Cloudflare 524). Please retry in a moment.";
  }
  if (text.includes("502") || text.includes("503") || text.includes("bad gateway") || text.includes("service unavailable")) {
    return "Run was inconclusive due to upstream node unavailability (HTTP 502/503). Please retry in a moment.";
  }
  return null;
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
      const baseWait = policy.backoffMs[Math.min(attempt, Math.max(0, policy.backoffMs.length - 1))] ?? 0;
      // Add random jitter between 10ms and 60ms to prevent thundering herds on rate limits
      const jitter = Math.floor(Math.random() * 50) + 10;
      const wait = baseWait + jitter;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw last;
}
