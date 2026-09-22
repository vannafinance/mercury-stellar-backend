import { routeMessage } from "./router";

/**
 * Decide which brain owns a fresh Copilot prompt.
 *
 * Explicit product reads and single actions use the deterministic capability path.
 * Open-ended allocation/optimisation requests use investigation. Swap deliberately
 * remains on its existing investigation path until its separate flow is migrated.
 */
export type CopilotEntryLane = "direct" | "strategy";

const LIFECYCLE_WRITE =
  /\b(?:open|create|set up|setup)\b[\s\S]{0,32}\b(?:margin|smart|c[- ]?)\s*account\b/i;

const SWAP_ACTION = /\b(swap|trade|exchange|convert)\b/i;

/**
 * Classify a copilot prompt into "direct" or "strategy".
 *
 * Derived from resolvability rather than phrasing lists:
 * - A prompt is "direct" if routeMessage fully resolves it into an executable
 *   action with every required slot satisfied, or into a read, client action, or fully sized plan.
 * - Anything routeMessage cannot resolve — an open-ended goal (prefer_max_yield),
 *   an unsized write (missing required amount/fraction), a comparison, or a clarify response —
 *   belongs to "strategy" (the investigation loop).
 * - Swap and lifecycle account creation retain their dedicated review flows on "strategy".
 */
export function classifyCopilotEntry(message: string): CopilotEntryLane {
  const text = message.trim();
  if (!text) return "direct";

  // Dedicated review flows that remain on the strategy/investigation loop
  if (SWAP_ACTION.test(text) || LIFECYCLE_WRITE.test(text)) {
    return "strategy";
  }

  const routed = routeMessage(text);

  if (routed.kind === "read") {
    return "direct";
  }

  if (routed.kind === "client") {
    return "direct";
  }

  if (routed.kind === "plan") {
    return "direct";
  }

  if (routed.kind === "write") {
    if (routed.op === "swap") {
      return "strategy";
    }
    // Optimization / yield-chasing goals belong to strategy
    if (routed.prefer_max_yield) {
      return "strategy";
    }
    // Check if required amount / sizing slot is missing
    if (routed.requires_amount) {
      const hasAmount = routed.amount != null && Number.isFinite(routed.amount);
      const hasFraction = routed.fraction != null && Number.isFinite(routed.fraction);
      const hasLpAmount = routed.amount_a != null && Number.isFinite(routed.amount_a);
      if (!hasAmount && !hasFraction && !hasLpAmount) {
        return "strategy";
      }
    }
    return "direct";
  }

  return "strategy";
}

