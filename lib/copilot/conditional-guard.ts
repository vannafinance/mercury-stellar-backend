/**
 * Guard against silently executing instructions the copilot cannot honour.
 *
 * Two shapes were dropping their most important clause and running anyway:
 *
 *   "if my health factor is above 2 borrow another 5 USDC, otherwise leave it"
 *       → routed straight to a borrow. The CONDITION was discarded, so the borrow
 *         would run whatever the health factor actually was — the exact opposite of
 *         what the user asked for.
 *
 *   "keep an eye on my position and if it starts getting risky pull some collateral"
 *       → answered with a one-off health reading and stopped. Nothing was watching
 *         anything afterwards, but nothing said so either, so the user is left
 *         believing a standing order is in place.
 *
 * Both are silent failures on the safety-critical clause, which is the worst shape a
 * failure can take. The architecture notes call for exactly this: the agent must not
 * execute until it is context-aware, and must warn when something is missing before
 * asking whether to proceed.
 *
 * This guard does not try to evaluate conditions or schedule work. It refuses to
 * pretend: it states plainly which part cannot be honoured and asks for an explicit
 * instruction instead.
 */

/** "do X only when Y" — a write gated on a condition we do not evaluate. */
const CONDITIONAL =
  /\bif\b[^.?!]*\b(then|otherwise|else)\b|\b(only if|unless|provided that|as long as|in case)\b|\bif\b[^.?!]*\b(above|below|under|over|drops?|falls?|rises?|goes?|is fine|is ok|is safe|stays?)\b/i;

/** "watch this and act later" — a standing order with no scheduler behind it. */
const STANDING_ORDER =
  /\b(keep an eye|keep watching|keep checking|monitor|watch my|watch the|whenever|every time|each time|as soon as|automatically|on its own|by yourself|without me|while i(?:'m| am)? (?:away|offline|asleep|not here|gone)|24\/7|round the clock|continuously|never let|make sure .* (?:never|always|stays?))\b/i;

export type AutomationGap =
  | { kind: "conditional"; message: string }
  | { kind: "standing_order"; message: string }
  | null;

const CONDITIONAL_MESSAGE =
  "That instruction is conditional, and I won't guess the condition — running the " +
  "action anyway would be the opposite of what you asked.\n\n" +
  "I execute one instruction at a time and can't gate an action on a value I haven't " +
  "checked yet. Do this instead:\n" +
  "1. Ask me for the value first (for example \"what's my health factor?\").\n" +
  "2. If it reads the way you expect, tell me the action outright (\"borrow 5 BLUSDC\").\n\n" +
  "That way you see the number the decision was based on before anything executes.";

const STANDING_ORDER_MESSAGE =
  "I can't watch your position while you're away — I only run when you send a message, " +
  "and every transaction still needs your signature, so nothing can execute unattended.\n\n" +
  "I'd rather say that plainly than answer once and leave you thinking something is " +
  "monitoring in the background.\n\n" +
  "What I can do right now:\n" +
  "1. Check your health factor and collateral this moment.\n" +
  "2. Tell you the exact price at which you'd approach liquidation.\n" +
  "3. Run an unwind the moment you ask for one.";

/**
 * Detect an instruction whose defining clause the copilot cannot honour.
 *
 * Only applied to writes and plans — a conditional phrased around a READ is harmless,
 * because reading a value never changes anything.
 */
export function detectAutomationGap(message: string, willWrite: boolean): AutomationGap {
  const m = (message || "").trim();
  if (!m) return null;

  // Standing orders are checked whatever the routed kind. "keep an eye on my position
  // and pull collateral if it gets risky" routes to a one-off health READ, which looks
  // like a successful answer while quietly ignoring the actual request. Reads are
  // harmless to run, but the unfulfilled promise to watch is the same either way, and a
  // message can be both ("watch it and if it drops, sell") — the honest answer is the
  // one about not being able to watch at all.
  if (STANDING_ORDER.test(m)) {
    return { kind: "standing_order", message: STANDING_ORDER_MESSAGE };
  }

  // A condition around a read is harmless — reading a value changes nothing — so this
  // only guards writes.
  if (willWrite && CONDITIONAL.test(m)) {
    return { kind: "conditional", message: CONDITIONAL_MESSAGE };
  }
  return null;
}
