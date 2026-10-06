/**
 * What the card says when auto-approve was on and the Sign Service would not sign a step.
 *
 * The card carries only a structured code (`signRefusal`): the Sign Service's own message is written for an
 * agent ("FULL unsigned envelope is in tool result field…", "re-run vanna_enable_auto_sign…") and is not
 * something to show a user. The sentence here is the app's own. The two cap codes are the Sign Service's
 * policy reasons for a spend over the per-transaction or daily limit; any other refusal gets the plain form.
 */
const LIMIT_CODES: ReadonlySet<string> = new Set(["over_per_tx_cap", "over_daily_cap"]);

export function signRefusalCopy(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return LIMIT_CODES.has(code)
    ? "This is outside your auto-approve limits, so it needs your own signature."
    : "Auto-approve could not sign this step, so it needs your own signature.";
}
