/**
 * Turns that need no investigation, answered before any model call or read.
 *
 * "hi" was running the full loop: scope resolution, several model turns and five MCP reads,
 * then a card explaining what it had checked. There is nothing to check. A greeting is not
 * a financial request, so reading an account to answer it is not caution — it is half a
 * minute of latency and a paid model turn spent on a question nobody asked.
 *
 * This is NOT the investigate/action router that was removed. That router tried to guess
 * whether a genuine financial request should skip the reads, which is exactly the judgement
 * it kept getting wrong. This decides something far narrower and checkable: whether the
 * message is a financial request AT ALL. Anything that could be one falls through to the
 * full investigation untouched — the default stays "investigate", and the gate only fires
 * on messages with no product content in them.
 *
 * Two cases:
 *  - a greeting or a "what can you do", answered with what this surface actually does;
 *  - anything the domain firewall rejects, refused with its own message rather than paid
 *    for. Off-domain prompts were reaching Vertex, which is what the firewall exists to
 *    prevent.
 */

import { evaluateDomainFirewall } from "../domain-firewall";

export interface ImmediateReply {
  kind: "greeting" | "off_domain";
  message: string;
}

/**
 * A greeting and nothing else. Anchored and length-capped on purpose: "hi" is a greeting,
 * but "hi, can I borrow 500 USDC" is a borrow request with a greeting attached, and
 * answering that with an introduction would drop the actual instruction.
 */
const GREETING =
  /^(?:hi|hii+|hey+|hello+|yo|sup|hola|namaste|greetings|good\s+(?:morning|afternoon|evening)|gm|thanks|thank\s+you|ty|ok(?:ay)?|cool|nice)[\s!.,?]*$/i;

/** Asking what the surface is or does — answerable from the product, with no reads. */
const CAPABILITY_QUESTION =
  /^(?:(?:so\s+)?(?:what|who)\s+(?:are|is|can)\s+(?:you|u|this|vanna)(?:\s+(?:do|help\s+with|capable\s+of))?|what\s+can\s+(?:you|u)\s+do|how\s+(?:do|does)\s+(?:you|this)\s+work|help|what\s+is\s+this)[\s!.,?]*$/i;

const IDENTITY =
  "I’m the Vanna copilot. I can look at your margin account — health factor, collateral, " +
  "debt — compare Earn, Blend and Aquarius rates, size a position against a health-factor " +
  "floor you set, and build a plan you approve before anything is signed.\n\n" +
  "Try “what’s my health factor?”, “lend 10 XLM”, or “use my USDC and XLM to build a " +
  "strategy that keeps the health factor above 1.3”.";

export function immediateReply(message: string): ImmediateReply | null {
  const text = message.trim();
  if (!text) return null;

  // Greetings are checked BEFORE the firewall: "hi" carries no product vocabulary, so the
  // firewall would reject it, and greeting someone with a refusal is the wrong answer.
  if (text.length <= 40 && (GREETING.test(text) || CAPABILITY_QUESTION.test(text))) {
    return { kind: "greeting", message: IDENTITY };
  }

  const verdict = evaluateDomainFirewall(text);
  if (!verdict.allow) return { kind: "off_domain", message: verdict.message };
  return null;
}
