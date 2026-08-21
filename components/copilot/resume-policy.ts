/**
 * How a multi-leg strategy is continued after one leg lands, and what the user
 * reads while a transaction is confirming.
 *
 * ## Why one leg per hop
 *
 * A 4-leg run (lend → deposit → borrow → supply) used to continue by posting
 * EVERY remaining leg in a single request. The server's runPlan happily executed
 * the whole tail in that one hop — deliberately, to avoid a client round-trip on
 * the happy auto-sign path — and there is no streaming, so the card could not
 * re-render until the entire batch came back. What the user saw was leg 2 frozen
 * on "submitted · waiting on ledger" for tens of seconds, then legs 3 and 4
 * appearing already settled, having never been shown running.
 *
 * The final state was correct — distinct hashes, right order. Only the progress
 * was invisible, which is its own bug: on a money path, "nothing is happening"
 * and "three transactions are happening" must not look the same.
 *
 * So the client now sends the FIRST remaining leg and keeps the rest. Each hop
 * returns after one leg, the card repaints, and the next hop starts. runPlan is
 * untouched and can still batch when something calls it with several legs.
 *
 * ## Why the client has to own the tail
 *
 * Send one leg and the server plans one leg, so its `remaining_legs` comes back
 * empty and it reports the strategy finished. The queue therefore cannot live on
 * the server: whoever splits the batch must remember what it held back.
 * pickRemainingLegs is that rule — trust the server while it still knows about
 * later legs, fall back to the client's tail once it stops.
 */

/** The shape both the server payload and the client queue share. */
export interface ResumeLegLike {
  op: string;
  asset?: string | null;
  amount?: number | null;
  leverage?: number | null;
  label?: string;
  token_in?: string | null;
  token_out?: string | null;
}

/**
 * Split a remaining-legs list into the one leg to run now and the rest to keep.
 *
 * Head is capped at one so every leg gets its own request, and therefore its own
 * running→settled repaint.
 */
export function splitResumeBatch<T>(legs: readonly T[] | null | undefined): {
  head: T[];
  tail: T[];
} {
  if (!legs?.length) return { head: [], tail: [] };
  return { head: [legs[0]], tail: legs.slice(1) };
}

/**
 * What still has to run after a hop.
 *
 * The server's list wins whenever it is non-empty: it reflects what actually
 * executed, including legs it skipped or re-ordered. An empty or absent list is
 * ambiguous — either the strategy is genuinely finished, or we only handed it
 * one leg and it finished THAT — so the client's own tail decides.
 *
 * `cardUnsettled` is the last resort: rebuild from the strategy card's pending /
 * needs_sign rows. Needed when the client queue was advanced before a hop
 * landed and then that hop aborted — without this, borrow disappears from the
 * queue and the run summarizes after deposit alone.
 */
export function pickRemainingLegs<T>(
  serverRemaining: readonly T[] | null | undefined,
  clientTail: readonly T[] | null | undefined,
  cardUnsettled?: readonly T[] | null | undefined,
): T[] {
  if (serverRemaining?.length) return [...serverRemaining];
  if (clientTail?.length) return [...clientTail];
  if (cardUnsettled?.length) return [...cardUnsettled];
  return [];
}

/**
 * True when a strategy still has work queued, from either source. Used to keep
 * "All steps completed" off the screen while the client is still holding legs.
 */
export function hasMoreLegs<T>(
  serverRemaining: readonly T[] | null | undefined,
  clientTail: readonly T[] | null | undefined,
  cardUnsettled?: readonly T[] | null | undefined,
): boolean {
  return pickRemainingLegs(serverRemaining, clientTail, cardUnsettled).length > 0;
}

/** Terminal statuses — the leg will not run again. */
const TERMINAL_STEP: ReadonlySet<string> = new Set([
  "ok",
  "done",
  "skipped",
  "error",
  "blocked",
  "stopped_hf",
]);

const SUCCESS_STEP: ReadonlySet<string> = new Set(["ok", "done"]);

/**
 * True when every step on the active strategy card is terminal and at least one
 * succeeded. Used as the hard-stop gate so idle re-renders cannot rebuild a
 * resume queue from stale pending rows / orphan staged plans.
 */
export function strategyIsComplete(
  steps: readonly { status?: unknown }[] | null | undefined,
): boolean {
  if (!steps?.length) return false;
  let anySuccess = false;
  for (const s of steps) {
    const st = String(s?.status ?? "");
    if (!TERMINAL_STEP.has(st)) return false;
    if (SUCCESS_STEP.has(st)) anySuccess = true;
  }
  return anySuccess;
}

/**
 * Whether the full strategy card is done — never a single-hop patch.
 *
 * A resume hop often returns `multi_leg_steps: [thisLegOnly]`. Treating that
 * 1-row array as "complete" cleared the borrow/supply queue while the card
 * still showed PENDING (Leg 2 settled · advancing to leg 3 forever).
 */
export function isStrategyRunComplete(
  fullCard: readonly { status?: unknown }[] | null | undefined,
): boolean {
  return strategyIsComplete(fullCard);
}

/**
 * Whether the client may auto-continue after an `executed` hop.
 *
 * **If the strategy card is complete → always false.** That is the live bug:
 * after 4/4 settled, `legsFromUnsettledSteps` / a leftover tail still made
 * `preferResume` true and toasted "Running Borrow… (N more after this)".
 *
 * When incomplete, only server remaining or the client's own split tail may
 * drive resume — not orphan unsettled card rows alone (those can be a previous
 * STAGED plan merged into the accumulator).
 */
export function isUnsizedAddLiquidity(leg: {
  op?: string | null;
  amount?: number | null;
} | null | undefined): boolean {
  if (!leg) return false;
  return String(leg.op) === "add_liquidity" && !(leg.amount != null && Number(leg.amount) > 0);
}

export function shouldAutoResume(opts: {
  complete: boolean;
  serverRemaining?: readonly unknown[] | null;
  clientTail?: readonly unknown[] | null;
  /** Prefer / can_resume flags from the server for this hop. */
  preferFlag?: boolean;
  canResumeWithAutoApprove?: boolean;
}): boolean {
  if (opts.complete) return false;
  const first = (opts.serverRemaining?.[0] ?? opts.clientTail?.[0]) as
    | { op?: string; amount?: number | null }
    | undefined;
  if (isUnsizedAddLiquidity(first)) return false;
  if (opts.preferFlag) return true;
  if (opts.canResumeWithAutoApprove) return true;
  if (opts.serverRemaining?.length) return true;
  if (opts.clientTail?.length) return true;
  return false;
}

/** Statuses that still need a hop (not settled, not permanently skipped). */
const UNSETTLED_FOR_RESUME: ReadonlySet<string> = new Set([
  "pending",
  "needs_sign",
  "needs_wallet_sign",
  "staged",
  "clarification",
]);

/**
 * Rebuild a resume queue from the strategy card when the client/server lists are
 * empty. Only legs that still need to run — never ok/done/skipped.
 */
export function legsFromUnsettledSteps(
  steps: readonly {
    op?: string | null;
    status?: unknown;
    asset?: string | null;
    amount?: number | null;
    leverage?: number | null;
    label?: string;
    token_in?: string | null;
    token_out?: string | null;
  }[] | null | undefined,
): ResumeLegLike[] {
  if (!steps?.length) return [];
  return steps
    .filter((s) => UNSETTLED_FOR_RESUME.has(String(s?.status ?? "")))
    .filter((s) => typeof s.op === "string" && s.op.length > 0)
    .filter((s) => s.amount == null || Number(s.amount) > 0)
    .map((s) => ({
      op: String(s.op),
      asset: s.asset ?? null,
      amount: s.amount != null ? Number(s.amount) : null,
      leverage: s.leverage ?? null,
      label: s.label,
      token_in: s.token_in ?? null,
      token_out: s.token_out ?? null,
    }));
}

// ── Claiming a leg for one transaction ──────────────────────────────────────

/**
 * Statuses that mean "this leg is the one a signature is about to settle".
 *
 * `pending` is deliberately absent. Including it once let a single signature
 * stamp legs 3 and 4 with leg 2's hash — three rows reading DONE against two
 * on-chain transactions. Claiming a transaction that never happened is the
 * worst thing this UI can do, so a pending leg is never touched.
 */
export const AWAITING_SIGNATURE: ReadonlySet<string> = new Set([
  "needs_sign",
  "needs_wallet_sign",
  "staged",
]);

/**
 * Apply `patch` to the FIRST leg awaiting a signature, and no others.
 *
 * One signature settles exactly one leg, so this is the only sanctioned way to
 * write a hash onto a row. Both callers go through it — the submit-time stamp
 * (hash + "confirming", status untouched) and the confirmation-time settle
 * (status → ok) — so the rule cannot drift between them.
 */
export function claimFirstAwaitingLeg<T extends { status?: unknown }>(
  steps: readonly T[] | null | undefined,
  patch: (leg: T) => T,
): { steps: T[]; claimed: boolean } {
  if (!steps?.length) return { steps: [], claimed: false };
  let claimed = false;
  const next = steps.map((s) => {
    if (claimed || !AWAITING_SIGNATURE.has(String(s?.status ?? ""))) return s;
    claimed = true;
    return patch(s);
  });
  return { steps: next, claimed };
}

// ── Ledger-wait copy ────────────────────────────────────────────────────────

/**
 * How long a Soroban testnet transaction realistically takes to confirm. Not a
 * timeout — just what the user is told to expect, so a normal wait does not read
 * as a hang.
 */
export const LEDGER_CONFIRM_HINT = "testnet can take ~30–60s";

/**
 * Status line for a submitted-but-unconfirmed leg.
 *
 * Leads with the hash because that is the part the user can act on: it proves
 * the transaction exists and is checkable on the explorer even if this tab is
 * closed. Silence plus a spinner proves nothing.
 */
export function ledgerWaitCopy(hash?: string | null): string {
  const short = hash ? `${hash.slice(0, 10)}…` : null;
  return short
    ? `Submitted ${short} — confirming on ledger (${LEDGER_CONFIRM_HINT})…`
    : `Confirming on ledger (${LEDGER_CONFIRM_HINT})…`;
}
