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
