import type { MCPClient } from "../mcp-client";
import { readCapabilities, resolveRead } from "./capabilities";
import { isRecord, parseDecision } from "./decision";
import type {
  InvestigationLimits, InvestigationOutcome, InvestigationRequest, InvestigationResult,
  Observation, ResearchModel,
  InvestigationProgress,
} from "./types";

/**
 * Budgets that must stay ordered: runtime (55s) + scope resolution (20s) <= the route's
 * 75s reply guarantee < the client's 120s. When the client's timeout was the tightest of
 * the three it fired first, replacing a real partial result with a bare
 * "the investigation timed out" and discarding every read already completed.
 */
const CEILINGS: Readonly<InvestigationLimits> = Object.freeze({
  maxTurns: 12,
  /**
   * Raised from 10 once the investigator has the full read catalogue and can
   * batch independent reads. Overrides may only lower this ceiling.
   */
  maxToolCalls: 24,
  /**
   * 45s, down from 55s. The loop is not the only thing inside the route's 75s promise:
   * scope resolution (20s) and the authoritative position read (8s) both block it, and
   * 20 + 8 + 55 came to 83s — past the deadline, which the user saw as "the connection
   * closed before the investigation finished". The loop needs less than it did anyway: the
   * position is now seeded as evidence, so three reads and a turn or two came out of every
   * account question, and each remaining read is capped at 15s of its own.
   */
  maxDurationMs: 45_000,
  /**
   * A single read gets 15s. Measured cause of a real zero-output run: MCP stalled (the
   * app's own `/api/analytics/accounts` was taking 100s+ against the same RPC at the time),
   * the reads inherited only the 55s RUN deadline, and one stall held the whole batch until
   * the run died. A read that cannot answer in 15s is an unavailable read, and the loop is
   * better off recording that and continuing than waiting for it.
   */
  maxReadDurationMs: 15_000,
  maxEvidenceAgeMs: 60_000,
  maxObservationBytes: 16_384,
});

function boundedLimits(overrides: Partial<InvestigationLimits> = {}): InvestigationLimits {
  const limits = { ...CEILINGS };
  for (const key of Object.keys(CEILINGS) as Array<keyof InvestigationLimits>) {
    const value = overrides[key] ?? CEILINGS[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > CEILINGS[key]) {
      throw new Error(`Invalid investigation limit: ${key}`);
    }
    limits[key] = value;
  }
  return limits;
}

const SENSITIVE_KEY = /^(?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key|secret|client[_-]?secret|password|assertion|x-vanna-user-assertion|(?:un)?signed[_-]?xdr|session[_-]?id)$/i;

/** No truncation of financial values: oversized or malformed results become errors. */
function sanitizeData(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error("Tool data is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeData(item, depth + 1));
  if (!isRecord(value)) throw new Error("Tool data is not JSON");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeData(item, depth + 1),
  ]));
}

function observationData(raw: unknown, maxBytes: number): Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).length === 0) throw new Error("Empty or invalid tool response");
  // Check the original before walking/copying it; data enters through the existing MCP JSON transport.
  const encoded = JSON.stringify(raw);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error("Tool response exceeded the observation budget");
  return sanitizeData(raw) as Record<string, unknown>;
}

function toolFailed(data: Record<string, unknown>): boolean {
  return !!data.error || data.isError === true || data.ok === false || data.success === false ||
    data.available === false || ["error", "failed", "rejected", "unavailable"].includes(String(data.status));
}

/** Stop waiting promptly. Legacy MCP reads cannot yet be cancelled at transport level. */
export function interruptible<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export interface InvestigationDependencies {
  model: ResearchModel;
  mcp: Pick<MCPClient, "call">;
  signal?: AbortSignal;
  limits?: Partial<InvestigationLimits>;
  /** Clock injection is for deterministic expiry tests. */
  now?: () => number;
  onProgress?: (event: InvestigationProgress) => void;
}

/**
 * A request-local research loop, intentionally not wired to handleChat in Phase 1.
 * Its terminal findings are model drafts with valid evidence references, not verified
 * financial claims. Proposal validation and authorization belong to later phases.
 */
export async function runInvestigation(
  request: InvestigationRequest,
  dependencies: InvestigationDependencies,
): Promise<InvestigationResult> {
  if (!request.message.trim() || request.message.length > 8_000 ||
    !request.scope.subject || !request.scope.network) throw new Error("Invalid investigation request");
  const limits = boundedLimits(dependencies.limits);
  if (request.task && (request.task.messages.length > 8 ||
    request.task.messages.some((message) => typeof message !== "string" || !message.trim() || message.length > 8_000) ||
    request.task.messages.join("").length > 24_000)) throw new Error("Investigation context exceeds its budget");
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  /**
   * Server-held evidence starts in the record. It is NOT counted against the tool budget
   * and is not entered in `seen`: no MCP call was spent on it, and it is not something a
   * retry could re-fetch.
   */
  const observations: Observation[] = (request.seed ?? []).map((seed) => structuredClone(seed));
  let modelTurns = 0;
  let toolCalls = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("deadline"), limits.maxDurationMs);
  const signal = dependencies.signal
    ? AbortSignal.any([controller.signal, dependencies.signal]) : controller.signal;
  const finish = (outcome: InvestigationOutcome): InvestigationResult => ({
    outcome, observations,
    usage: { modelTurns, toolCalls, elapsedMs: Math.max(0, now() - startedAt) },
    executionAllowed: false,
  });
  const stopReason = (): "cancelled" | "deadline" | null => {
    if (dependencies.signal?.aborted) return "cancelled";
    if (controller.signal.aborted || now() - startedAt >= limits.maxDurationMs) return "deadline";
    return null;
  };
  const seen = new Map<string, { at: number; status: Observation["status"]; attempts: number }>();
  const scope = { ...request.scope };
  const context = {
    network: scope.network, hasWallet: !!scope.trader,
    hasSmartAccount: !!scope.trader && !!scope.smartAccount,
  };
  const history = (request.history ?? []).slice(-8).map((entry) => ({
    role: entry.role, text: entry.text.slice(0, 1200),
  }));
  const progress = (event: InvestigationProgress) => {
    // UI delivery failures must not alter the research decision or create retries.
    try { dependencies.onProgress?.(event); } catch { /* client may have disconnected */ }
  };

  try {
    while (modelTurns < limits.maxTurns) {
      const stopped = stopReason();
      if (stopped) return finish({ kind: "stopped", reason: stopped });
      modelTurns += 1;
      progress({ kind: "reviewing", turn: modelTurns });
      let raw: unknown;
      try {
        raw = await interruptible(() => dependencies.model({
          message: request.message, history: structuredClone(history), context: { ...context },
          capabilities: readCapabilities(scope), observations: structuredClone(observations),
          remaining: { turns: limits.maxTurns - modelTurns, toolCalls: limits.maxToolCalls - toolCalls },
          ...(request.task ? { task: structuredClone(request.task) } : {}),
        }, signal), signal);
      } catch {
        return finish({ kind: "stopped", reason: stopReason() ?? "model_unavailable" });
      }
      const afterModel = stopReason();
      if (afterModel) return finish({ kind: "stopped", reason: afterModel });
      let decision;
      try {
        const encoded = JSON.stringify(raw);
        decision = typeof encoded === "string" && Buffer.byteLength(encoded, "utf8") <= 16_384
          ? parseDecision(raw) : null;
      } catch {
        decision = null;
      }
      if (!decision) return finish({ kind: "stopped", reason: "invalid_decision" });
      if (decision.kind === "research_complete") {
        const evidence = new Map(observations.map((observation) => [observation.id, observation]));
        const valid = decision.findings.every((finding) => finding.evidenceIds.every((id) => {
          const observation = evidence.get(id);
          const age = observation ? now() - observation.observedAt : -1;
          return observation?.status === "ok" && age >= 0 && age <= limits.maxEvidenceAgeMs;
        }));
        return valid ? finish(decision) : finish({ kind: "stopped", reason: "invalid_evidence" });
      }
      if (decision.kind !== "inspect") return finish(decision);
      if (toolCalls >= limits.maxToolCalls) return finish({ kind: "stopped", reason: "tool_budget" });

      // Resolve the whole batch before running any of it, so an invalid capability or
      // argument anywhere in the decision costs no MCP calls at all.
      const resolved: Array<{ request: typeof decision.reads[number]; read: ReturnType<typeof resolveRead>; key: string }> = [];
      for (const request of decision.reads) {
        let read: ReturnType<typeof resolveRead>;
        try {
          read = resolveRead(request.capability, request.args, scope);
        } catch {
          return finish({ kind: "stopped", reason: "invalid_decision" });
        }
        resolved.push({ request, read, key: JSON.stringify([read.tool, read.args]) });
      }
      // A batch may not exceed the remaining tool budget; the model is told what is left.
      if (toolCalls + resolved.length > limits.maxToolCalls) {
        return finish({ kind: "stopped", reason: "tool_budget" });
      }
      // Every read in the batch must be new. Re-asking for fresh evidence already held is
      // the signal the loop is not progressing, exactly as in the single-read case.
      for (const { key } of resolved) {
        const prior = seen.get(key);
        if (prior && ((prior.status === "ok" && now() - prior.at <= limits.maxEvidenceAgeMs) || prior.attempts >= 2)) {
          return finish({ kind: "stopped", reason: "repeated_read" });
        }
      }

      /**
       * Run the batch CONCURRENTLY. These reads are independent by construction — that is
       * the precondition for batching them — and MCP latency, not model latency, is what
       * pushed a four-read turn past the client's timeout. Ids are assigned before dispatch
       * and results appended in request order, so evidence numbering stays deterministic
       * regardless of which read returns first.
       */
      const dispatched = resolved.map(({ request, read, key }, offset) => {
        const id = `e${toolCalls + offset + 1}`;
        const label = request.capability.replaceAll("_", " ");
        progress({ kind: "reading", capability: request.capability, label });
        const observation: Observation = {
          id, capability: request.capability, args: { ...request.args },
          // Timestamp the start of the read conservatively; upstream data can be older still.
          observedAt: now(), status: "error",
        };
        /**
         * Each read gets its OWN deadline as well as the run's. Sharing only the run signal
         * meant one stalled call held the entire concurrent batch until the run expired,
         * which is how a real turn produced no evidence at all.
         */
        const readSignal = AbortSignal.any([signal, AbortSignal.timeout(limits.maxReadDurationMs)]);
        const settled = interruptible(
          () => dependencies.mcp.call(read.tool, read.args, scope.trader ?? undefined), readSignal,
        ).then((response) => {
          try {
            observation.data = observationData(response, limits.maxObservationBytes);
            observation.status = toolFailed(observation.data) ? "error" : "ok";
            if (observation.status === "error") {
              observation.error = "MCP returned unavailable or failed data; do not use it as a financial fact.";
            }
          } catch {
            observation.data = undefined;
            observation.error = "MCP returned invalid or oversized data. No value was inferred.";
          }
        }).catch(() => {
          // Exception strings can carry upstream credentials; do not feed them to the model.
          // A read that ran out of its own time is reported as such: the model can retry a
          // timeout usefully, whereas "failed" invites it to treat the venue as broken.
          observation.error = readSignal.aborted && !signal.aborted
            ? "MCP read exceeded its time limit. No value was inferred."
            : "MCP read failed. No value was inferred.";
        }).finally(() => {
          if (!signal.aborted) progress({ kind: "read_finished", capability: request.capability, label, status: observation.status });
        });
        return { key, label, capability: request.capability, observation, settled, prior: seen.get(key) };
      });
      toolCalls += resolved.length;
      await Promise.all(dispatched.map((entry) => entry.settled));
      /**
       * On a DEADLINE, record the batch before stopping. Returning early discarded every
       * read that had already completed in the same batch, so the run reported "0 reads"
       * while holding real evidence it had paid for — the user waited a minute and got
       * nothing back. Running out of time is a reason to stop reading, not to throw away
       * what came back.
       *
       * CANCELLATION is different and stays a discard: the client is gone, nobody will see
       * the result, and a read that landed after the cancel should not become evidence for
       * a later turn that must not happen.
       */
      const afterBatch = stopReason();
      if (afterBatch !== "cancelled") {
        for (const entry of dispatched) {
          observations.push(entry.observation);
          seen.set(entry.key, {
            at: entry.observation.observedAt, status: entry.observation.status,
            attempts: (entry.prior?.attempts ?? 0) + 1,
          });
        }
      }
      if (afterBatch) return finish({ kind: "stopped", reason: afterBatch });
    }
    return finish({ kind: "stopped", reason: "turn_budget" });
  } finally {
    clearTimeout(timer);
  }
}
