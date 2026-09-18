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
 * it kept getting wrong. This decides something far narrower: whether the message is a
 * financial request AT ALL. Product vocabulary falls through to investigation with no extra
 * model call. The leftover (greetings, identity, off-domain) never starts that loop.
 *
 * Two leftover cases:
 *  - a greeting / "who are you", answered by Flash-Lite (hard 2s abort);
 *  - anything the domain firewall rejects, refused with its own message rather than paid
 *    for. Off-domain prompts were reaching Vertex, which is what the firewall exists to
 *    prevent.
 */

import { abuseTripwire, evaluateDomainFirewall, guardUserPrompt } from "../domain-firewall";
import { lpPairs } from "../registry/assets";
import { WORKFLOW_OPS } from "../workflow/types";
import { classifySocialLane, isGreetingOrIdentityLeftover, isProductInvestigationTurn } from "./social-lane";

export interface ImmediateReply {
  kind: "greeting" | "capability" | "off_domain";
  message: string;
}

/** A swap capability question has no amount to quote; answer from executable ops. */
const SWAP_CAPABILITY_QUESTION = /^(?:can|could|do)\s+(?:you|u)\s+swap\b/i;

/**
 * Last resort when Flash-Lite aborts on a leftover that the firewall would otherwise
 * cheap-allow as a greeting and dump into investigation. Not the happy-path copy.
 */
const SOCIAL_TIMEOUT_REPLY =
  "I’m Vanna Copilot. Ask about your margin account, Earn, Farm, or a move you want sized from live reads.";

export async function immediateReply(
  message: string,
  opts?: { subject?: string; signal?: AbortSignal; hasPageContext?: boolean },
): Promise<ImmediateReply | null> {
  const text = message.trim();
  if (!text) return null;

  const abuse = abuseTripwire(text);
  if (abuse) return { kind: "off_domain", message: abuse.message };

  if (SWAP_CAPABILITY_QUESTION.test(text) && !/\d/.test(text) && WORKFLOW_OPS.includes("swap")) {
    const pairs = lpPairs().map((pair) => `${pair.venue}: ${pair.tokens.join("/ ")}`).join("; ");
    return { kind: "capability", message: `Yes. I can prepare a swap on ${pairs}. Tell me the amount and which token you want to spend or receive. I’ll show a live quote for you to confirm before anything is signed.` };
  }

  // Product turns skip the greeting model entirely — same path as before this lane.
  if (isProductInvestigationTurn(text)) {
    if (opts?.subject && opts.signal) {
      const verdict = await guardUserPrompt(text, {
        subject: opts.subject, signal: opts.signal, hasPageContext: opts.hasPageContext,
      });
      if (!verdict.allow) return { kind: "off_domain", message: verdict.message };
    }
    return null;
  }

  const social = await classifySocialLane(text, opts?.signal);
  if (social?.lane === "social") {
    return { kind: "greeting", message: social.reply };
  }

  // Production always passes subject+signal. Identity leftovers cheap-allow in the
  // firewall, so falling through to guardUserPrompt used to return null and start a
  // 20s wallet-scope read for "Hi who are you??". Lite work/timeout must not investigate.
  if (isGreetingOrIdentityLeftover(text)) {
    return { kind: "greeting", message: SOCIAL_TIMEOUT_REPLY };
  }

  const leftover = evaluateDomainFirewall(text);
  if (leftover.allow && leftover.reason === "allow:short_token") {
    return { kind: "greeting", message: SOCIAL_TIMEOUT_REPLY };
  }

  if (opts?.subject && opts.signal) {
    const verdict = await guardUserPrompt(text, {
      subject: opts.subject, signal: opts.signal, hasPageContext: opts.hasPageContext,
    });
    if (!verdict.allow) return { kind: "off_domain", message: verdict.message };
    return null;
  }

  const verdict = evaluateDomainFirewall(text);
  if (!verdict.allow) return { kind: "off_domain", message: verdict.message };
  return { kind: "greeting", message: SOCIAL_TIMEOUT_REPLY };
}
