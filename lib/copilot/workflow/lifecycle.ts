import { routeMessage } from "../router";

/**
 * Writes that are not plans. They spend no token amount and are not composed by the
 * sizer — the connected G-wallet is the only input. Kept off `WORKFLOW_OPS` so the
 * shape matrix and journal never treat them as sized legs.
 */
export const LIFECYCLE_WRITES = ["create_account"] as const;
export type LifecycleWriteOp = (typeof LIFECYCLE_WRITES)[number];

export function isLifecycleWriteOp(value: string): value is LifecycleWriteOp {
  return (LIFECYCLE_WRITES as readonly string[]).includes(value);
}

/**
 * A lifecycle write is accepted only when the model named an op from this list and
 * quoted the user's own message. Sized actions or plans beside it win: opening the
 * account cannot share a turn with a step that spends it.
 */
export function anchoredLifecycleWrite(
  write: { op: string; sourceQuote: string } | undefined,
  messages: readonly string[],
  hasSizedWork: boolean,
): LifecycleWriteOp | null {
  if (hasSizedWork || !write || !isLifecycleWriteOp(write.op)) return null;
  if (!write.sourceQuote || !messages.some((message) => message.includes(write.sourceQuote))) return null;
  return write.op;
}

/**
 * Resolve a lifecycle write with dual sources and a shared veto.
 *
 * 1. Veto first. Opening an account cannot share a turn with a leg that spends it.
 * 2. Source 1 — the model, anchored (exact quote match against user message).
 * 3. Source 2 — the deterministic router. Reuses routeMessage(messages[0]).
 *
 * When source 1 is rejected but source 2 fires, log a diagnostic console.warn
 * noting whether modelWrite was absent, missing quote, or quote-mismatched.
 */
export function resolveLifecycleWrite(input: {
  modelWrite: { op: string; sourceQuote: string } | undefined;
  messages: readonly string[];
  hasSizedWork: boolean;
}): LifecycleWriteOp | null {
  // 1. Veto first: opening an account cannot share a turn with a leg that spends it.
  if (input.hasSizedWork) return null;

  // 2. Source 1 — the model, anchored.
  const modelOp = anchoredLifecycleWrite(input.modelWrite, input.messages, false);
  if (modelOp) return modelOp;

  // 3. Source 2 — the deterministic router.
  if (input.messages.length > 0 && typeof input.messages[0] === "string") {
    const routed = routeMessage(input.messages[0]);
    if (routed.kind === "write" && isLifecycleWriteOp(routed.op)) {
      const reason = !input.modelWrite
        ? "absent"
        : !input.modelWrite.sourceQuote
          ? "missing quote"
          : "quote-mismatched";
      console.warn(
        `[lifecycle] model lifecycle write rejected (${reason}) but deterministic router resolved op '${routed.op}'. Using router op.`,
      );
      return routed.op;
    }
  }

  return null;
}
