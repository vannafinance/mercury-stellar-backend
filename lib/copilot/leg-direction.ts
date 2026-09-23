import { OP_FLOW, POCKET_HOLDER, type Pocket, type WorkflowOp } from "./workflow/types";

/**
 * Which way a leg moves value, and whether that contradicts what the user said.
 *
 * Live, 22 Sep: "withdraw 30 XLM from blend and lend it in earn" planned
 * `lend 30 XLM` then `deploy_to_blend BLUSDC` — money INTO Blend, the opposite of
 * what was asked, in an asset never mentioned, one signature from executing. The
 * multi-goal planner pushes a Blend leg on the mere PRESENCE of the word "blend"
 * (`any(text, "farm", "blend", "deploy")`), with nothing anywhere asking which
 * direction the money was meant to go. The single-leg route reads the same sentence
 * correctly, so only plans were wrong.
 *
 * Direction is already stated once, as data, in `OP_FLOW`'s `from`/`to` pockets. This
 * reads it rather than teaching a planner which verbs mean "out" — a verb-to-op table
 * is how the two got to disagree in the first place.
 */

/**
 * Planner spellings for ops `OP_FLOW` names differently. Names only — an alias never
 * changes a flow, it just says which canonical row to read.
 */
const OP_ALIASES: Readonly<Record<string, WorkflowOp>> = {
  deploy_to_blend: "supply_blend",
  supply_to_blend: "supply_blend",
  withdraw_from_blend: "blend_withdraw",
};

/** The pockets a leg draws from and lands in, for any spelling the planner uses. */
export function flowOf(op: string): { from: Pocket; to: Pocket } | null {
  const canonical = (OP_ALIASES[op] ?? op) as WorkflowOp;
  const flow = OP_FLOW[canonical];
  return flow ? { from: flow.from, to: flow.to } : null;
}

/**
 * `debt` is a pocket but never a spoken source.
 *
 * Every other pocket is somewhere a user can say money came "from". Debt is borrowing
 * capacity — a borrow draws on it, but nobody says "from my debt" to mean that, while
 * "repay from my wallet" is ordinary. Read as a stated source it would make `repay`
 * (account → debt) look like it lands in the source, and refuse a legitimate repay.
 */
const UNSPOKEN_POCKETS: readonly Pocket[] = ["debt"];

/** Words that name a pocket without being its key. Everything else IS its key. */
const POCKET_SYNONYMS: Readonly<Record<string, Pocket>> = {
  margin: "account",
  collateral: "account",
  pool: "lp",
};

/**
 * The words a user says for each pocket, derived from the pocket table rather than
 * listed here — a pocket's own name is the word for it, so a pocket added to
 * `POCKET_HOLDER` is understood without touching this file. Only the words that differ
 * from the key need saying.
 */
const VENUE_POCKETS: Readonly<Record<string, Pocket>> = {
  ...Object.fromEntries(
    (Object.keys(POCKET_HOLDER) as Pocket[])
      .filter((pocket) => !UNSPOKEN_POCKETS.includes(pocket))
      .map((pocket) => [pocket, pocket] as const),
  ),
  ...POCKET_SYNONYMS,
};

/**
 * Pockets the sentence names as the SOURCE of the money — "from blend", "out of earn".
 *
 * Grammar, not vocabulary: a source preposition in front of a venue word. That is why
 * this can be shared by every op instead of belonging to any one of them.
 */
export function statedSourcePockets(text: string): Set<Pocket> {
  const found = new Set<Pocket>();
  const matches = String(text || "")
    .toLowerCase()
    .matchAll(/\b(?:from|out\s+of|off\s+of)\s+(?:my\s+)?(?:the\s+)?([a-z]+)/g);
  for (const match of matches) {
    const pocket = VENUE_POCKETS[match[1]];
    if (pocket) found.add(pocket);
  }
  return found;
}

/**
 * True when this leg moves INTO a pocket the user named as the source.
 *
 * The one-sided test is the point: "withdraw from blend and supply to blend" names
 * Blend as both, and is a sentence a user could legitimately mean, so only a leg whose
 * destination is a stated source AND whose own source is not, is a contradiction.
 */
export function contradictsStatedSource(op: string, text: string): boolean {
  const flow = flowOf(op);
  if (!flow) return false;
  const sources = statedSourcePockets(text);
  return sources.has(flow.to) && !sources.has(flow.from);
}

/**
 * Whether an op draws on borrowing capacity — read from `OP_FLOW`, never from the verb.
 *
 * `debt` as a SOURCE is what "this creates new debt" means, and it is already stated once,
 * as data, for every op. An op added to `OP_FLOW` is classified here without touching this
 * file.
 */
export function drawsNewDebt(op: string): boolean {
  return flowOf(op)?.from === "debt";
}

/**
 * True when two readings of the SAME sentence disagree about whether it creates debt.
 *
 * Live, 23 Sep, auto-approve on, one click from executing: "lend me 50xlm" was understood as
 * "Borrow 50 XLM on margin". The deterministic extractor read the same sentence as `lend`.
 * Supplying capital and taking on debt are opposite actions, and the word that flipped it was
 * "me" — "lend me X" idiomatically means "loan me X", which is a defensible reading of the
 * English and the wrong reading of a product whose Earn surface is called Lend.
 *
 * Because BOTH readings are defensible, this does not pick one. It reports that the sentence
 * has two readings which differ on the only axis that cannot be undone by the user later.
 * Resolving it by mapping the words "lend me" to an op would rebuild the verb-to-op table
 * this module exists to replace, and would be wrong whenever "lend me" really did mean
 * borrow.
 *
 * Narrow on purpose. Ops that differ in destination but agree about debt — `lend` versus
 * `deposit_collateral`, both "put money in" — are NOT a disagreement worth stopping for; the
 * cost of asking must stay below the cost of the mistake.
 */
export function disagreesOnNewDebt(a: string, b: string): boolean {
  const flowA = flowOf(a);
  const flowB = flowOf(b);
  if (!flowA || !flowB) return false;
  return (flowA.from === "debt") !== (flowB.from === "debt");
}
