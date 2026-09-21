/**
 * Decide which brain owns a fresh Copilot prompt.
 *
 * Explicit product reads and single actions use the deterministic capability path.
 * Open-ended allocation/optimisation requests use investigation. Swap deliberately
 * remains on its existing investigation path until its separate flow is migrated.
 */
export type CopilotEntryLane = "direct" | "strategy";

const STRATEGY_GOAL =
  /\b(strateg(?:y|ize)|allocat(?:e|ion)|optim(?:ize|ise|ization|isation)|rebalance|recommend|compare (?:the )?(?:rates|returns|pools|venues|options)|best (?:rate|return|yield|apy|pool|option)|maximi[sz]e (?:my )?(?:return|yield|apy)|what should i do|where should i (?:put|deploy|invest)|build me (?:a )?(?:plan|portfolio)|invest my (?:wallet|funds|balance)|deploy my (?:wallet|funds|balance))\b/i;

const STRATEGY_SIZING =
  /\b(as much as possible|max(?:imum)? (?:i can|safe|safely)|keep (?:my )?(?:hf|health factor)|health factor (?:above|below|at least|doesn'?t|does not)|without (?:my )?(?:hf|health factor)|use (?:whatever|whichever) is best)\b/i;

const LIFECYCLE_WRITE =
  /\b(?:open|create|set up|setup)\b[\s\S]{0,32}\b(?:margin|smart|c[- ]?)\s*account\b/i;

const SWAP_ACTION = /\b(swap|trade|exchange|convert)\b/i;

export function classifyCopilotEntry(message: string): CopilotEntryLane {
  const text = message.trim();
  if (!text) return "direct";

  if (
    SWAP_ACTION.test(text) ||
    LIFECYCLE_WRITE.test(text) ||
    STRATEGY_GOAL.test(text) ||
    STRATEGY_SIZING.test(text)
  ) {
    return "strategy";
  }
  return "direct";
}
