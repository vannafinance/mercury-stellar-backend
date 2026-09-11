/**
 * When the unnamed (non-copilot) surface should trust the keyword router
 * versus ask Vertex. Copilot never reaches this (`investigation_owns_planning`).
 * Assistant writes redirect before it. Extracted from handle.ts so that file
 * can shrink toward execution-only.
 */
import type { RoutedIntent } from "./types";

/**
 * Read `template_id`s that must NOT be auto-trusted — reviewed by Vertex before the
 * final answer stands, even though the deterministic router already produced one.
 *
 * This used to be the other way round: an opt-IN allowlist, where a read had to be
 * added here before it was trusted, and every entry was added only after it was
 * reported live as broken. "Swap 10 XLM to USDC" ignored the router's own correct
 * "which USDC?" clarify because `clarify` wasn't yet a trusted kind; "What is Balance of
 * XLM in my Margin Account" (a word-order variant of an already-fixed phrasing) fell to
 * the generic capabilities blurb because `query_collateral` hadn't been added yet.
 * Building a coverage test (`tests/lib/keyword-confident-coverage.test.ts`) to check
 * that allowlist against what the router actually produces found FIVE more reads in the
 * same broken state in one pass (`query_can_borrow`, `query_can_withdraw`,
 * `query_inactive`, `query_vtoken`, `query_exchange_rate`) — an opt-IN list will keep
 * finding new gaps exactly this way, one at a time, forever, because "forgot to add the
 * new route here" leaves no trace until someone hits it.
 *
 * Flipped to opt-OUT: every deterministic read is now trusted by default, the same way
 * every deterministic write/clarify/restricted/auto_sign/client result already is.
 * Empty today — nothing currently needs Vertex to double-check it — but the escape
 * hatch stays for a genuinely fuzzy future read where sending it to Vertex anyway is a
 * deliberate design choice, not a forgotten allowlist entry.
 */
export const VERTEX_REVIEWED_READ_TEMPLATES: readonly string[] = [];

export function needsSemanticIntent(message: string, kwFast: RoutedIntent): boolean {
  const t = message.trim();
  // A keyword PLAN already lists every leg. Length > 90 used to force Vertex, which
  // collapsed "lend 1000 XLM, 100 BLUSDC, 100 SOUSDC, 100 AQUSDC" to one lend.
  if (kwFast.kind === "plan") return false;
  if (t.length > 90) return true;
  const actionVerbs =
    t.match(
      // "create"/"open"/"connect" count as actions: without them "create a wallet and
      // deposit 10 XLM" scored one verb, took the fast keyword path, and returned only
      // the wallet dialog — silently dropping the deposit.
      //
      // "post" is the same trap one word over: "post 200 XLM and borrow BLUSDC" counted
      // ONE verb (only "borrow"), so this stayed false, the deterministic single-borrow
      // branch answered alone with no Vertex involved, and it borrowed 200 BLUSDC with
      // no deposit leg at all — "200" was the deposit amount, attached to the wrong verb.
      // "deposit 200 XLM and borrow BLUSDC" (same sentence, one word different) took the
      // Vertex path and built the correct two-leg plan, which is how this survived
      // undetected: the fast path silently answers, it does not visibly fail.
      /\b(swap|lend|borrow|deposit|post|repay|farm|invest|supply|withdraw|redeem|add|remove|allocate|park|grow|deploy|create|open|connect)\b/gi,
    ) || [];
  const uniqueVerbs = new Set(actionVerbs.map((v) => v.toLowerCase()));
  if (uniqueVerbs.size >= 2) return true;
  // Yield + farm in one breath even if only one “verb” matched cleanly
  if (/\b(park|lend|earn|yield)\b/i.test(t) && /\b(farm|blend|deploy)\b/i.test(t)) return true;
  if (
    /\b(invest|strategy|rebalance|optimize|max(?:imum)?\s*profit|wherever|whatever|make sure|ensure|keeping|while|then also|and also|multi[- ]?step)\b/i.test(
      t,
    ) &&
    !/^\s*(swap|lend|borrow|deposit|repay|supply|farm blend)\b/i.test(t)
  ) {
    return true;
  }
  /**
   * "what is the current rate of farm's bXLM and bUSDC" — a plain comparison
   * QUESTION naming two tickers, not a plan — tripped this check anyway: "and" joins
   * "bXLM and bUSDC" (a noun list, not two clauses) and "farm's" satisfies `\bfarm\b`
   * with no way for the regex to tell the possessive NOUN ("the farm's X") from the
   * imperative VERB ("farm 20 XLM"). Reported live: forced this off the deterministic
   * router.ts answer (which correctly resolves it to the Blend read) and onto Vertex,
   * which guessed a different, wrong tool. A possessive "farm's"/"blend's"/"earn's"
   * right before the noun it modifies is never the action verb this check means to
   * catch — real plans say "farm 20 XLM", never "farm's XLM".
   */
  const possessiveVenueNoun = /\b(farm|blend|earn)'s\b/i.test(t);
  // Two independent clauses joined by and/then with risk language
  if (
    !possessiveVenueNoun &&
    /\b(and|then)\b/i.test(t) &&
    /\b(health|liquidat|profit|yield|farm|earn|hf)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

export function isKeywordConfident(message: string, kwFast: RoutedIntent): boolean {
  if (needsSemanticIntent(message, kwFast)) return false;
  return (
    kwFast.kind === "write" ||
    kwFast.kind === "plan" ||
    kwFast.kind === "restricted" ||
    kwFast.kind === "auto_sign" ||
    // G-wallet create/connect is always client-side — never let Vertex map it to create_account
    kwFast.kind === "client" ||
    /**
     * A deterministic "which one do you mean?" is the safest kind here, not one to
     * distrust — yet it was the one kind missing from this list, so it was never
     * "confident" and Vertex re-decided the message from scratch every time.
     *
     * That is why "swap 10 XLM to USDC" kept answering "Vanna does not offer direct
     * spot token swaps" — router.ts's own clarify for exactly this case ran, produced
     * the right "which USDC?" message, and was thrown away right here because
     * `kind: "clarify"` matched none of the branches above. Vertex then answered the
     * question independently and never saw the clarify at all. Same root cause as the
     * bare "vtoken"/"supply balance" reads answering with no chips: those routes exist
     * in router.ts too, and were exchanged for Vertex's version for the same reason.
     *
     * `clarify_capabilities` is a DIFFERENT kind of clarify from the one this comment
     * defends, and must not ride along with it — it is router.ts's own last-resort
     * "nothing matched" catch-all, not a deliberate disambiguation. Treating it as
     * confident meant Vertex was never even asked for any phrasing router.ts's regex
     * net had not yet special-cased, no matter how ordinary — "What is my AQUSDC
     * balance" / "How much AQUSDC do I have" both hit this exact fallback and got the
     * generic capability blurb, even though Vertex already has a working
     * `vanna_get_wallet_balance` tool for exactly this question (confirmed live: once
     * this fallback stopped short-circuiting to Vertex, it answered correctly). Every
     * other unmatched-by-router.ts message already defers to Vertex; this fallback
     * should not be the one exception that gives up before asking.
     */
    (kwFast.kind === "clarify" && kwFast.template_id !== "clarify_capabilities") ||
    // Opt-out, not opt-in — see VERTEX_REVIEWED_READ_TEMPLATES's own doc comment for
    // why: a deterministic read is trusted the same way every other kind here already
    // is, unless its template_id is deliberately named as needing Vertex's review.
    (kwFast.kind === "read" &&
      !!kwFast.template_id &&
      !VERTEX_REVIEWED_READ_TEMPLATES.includes(kwFast.template_id))
  );
}
