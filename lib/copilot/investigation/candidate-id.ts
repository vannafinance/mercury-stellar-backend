/**
 * Candidate ids — minted, parsed and validated here, and nowhere else.
 *
 * Three parties handle the same string: the generator mints it, the card posts it back,
 * and the propose route decides whether to accept it. When each side spelled the shape
 * on its own, the generator wrote `supply_idle_BLUSDC` and the route accepted only
 * `[a-z0-9_]`, so no option button ever worked (first signed-in battery, 11 Sep). The fix
 * is not to lowercase at the three call sites: it is that nothing outside this module may
 * spell the shape. Producers call `candidateId()`, consumers call `parseCandidateId()`,
 * and the route calls `isCandidateId()`.
 *
 * Shape: `<kind>:<asset>`. The kind is a strategy family this module registers; the asset
 * is the symbol the rate comparison carried, passed through unchanged. A symbol nobody
 * enumerated — digits, hyphens, mixed case, even a `CODE:ISSUER` pair — round-trips
 * without any list here agreeing to it, because the colon splits on the first occurrence
 * only and the asset side is never interpreted. `requested_actions` is the one id with no
 * asset: it names the user's own literal steps rather than a generated strategy.
 *
 * Authority over WHICH ids may be proposed stays with the sealed investigation evidence
 * (`allowedCandidateIds`, exact match). `isCandidateId` is hygiene on untrusted input —
 * a length bound and a printable-ASCII check — not an allowlist, so registering a new kind
 * here never requires touching the route.
 */

export interface CandidateKindTraits {
  /** The shape opens new debt. Sizing and the risk gate key on this. */
  borrows: boolean;
  /** Where the supplied value ends up. Drives which compile path and which account. */
  venue: "blend" | "earn" | "margin";
  /**
   * Where the supplied tokens come from. `wallet` means idle G-wallet funds that must be
   * moved (deposited to margin for Blend, spent directly for Earn); `borrow` means the
   * proceeds of the borrow leg, which already sit in the C-address.
   */
  funding: "wallet" | "borrow";
}

/**
 * The strategy families the deterministic generator can produce and the compiler can turn
 * into steps. Closed by design — "only arithmetic and authority are closed" — because each
 * row has sizing and compile code behind it. Adding a row is the whole registration.
 */
export const CANDIDATE_KINDS = {
  /** Deposit idle wallet tokens into margin and supply them to Blend; no new debt. */
  supply_idle: { borrows: false, venue: "blend", funding: "wallet" },
  /** Lend idle wallet tokens to a Vanna Earn pool straight from the G-wallet; no new debt. */
  lend_idle: { borrows: false, venue: "earn", funding: "wallet" },
  /** Borrow against margin headroom and supply the proceeds to Blend. */
  borrow_supply: { borrows: true, venue: "blend", funding: "borrow" },
  /**
   * A shape the model composed from the op vocabulary and `plan.ts` sized. Its traits
   * vary per plan, so consumers read them off the candidate (`borrows`, `venue`, `steps`)
   * rather than off this row; the row exists so the id parses and the kind is registered.
   */
  composed: { borrows: false, venue: "margin", funding: "wallet" },
} as const satisfies Record<string, CandidateKindTraits>;

export type CandidateKind = keyof typeof CANDIDATE_KINDS;

/** The id for "prepare exactly the steps the user stated", which no generator mints. */
export const REQUESTED_ACTIONS_ID = "requested_actions";

const SEPARATOR = ":";
const MAX_LENGTH = 80;
/** A kind is snake_case; an asset is any printable ASCII with no whitespace. */
const SHAPE = /^[a-z][a-z0-9_]*(?::[!-~]+)?$/;

export function candidateId(kind: CandidateKind, asset: string): string {
  const id = `${kind}${SEPARATOR}${asset}`;
  if (!isCandidateId(id)) {
    // The generator is the only caller and the asset comes from a read, so this is a
    // programming error, not user input: fail loudly rather than mint a dead button.
    throw new Error(`candidate id is not representable: ${JSON.stringify(id)}`);
  }
  return id;
}

/** Shape check for untrusted input. Says nothing about whether the id was ever offered. */
export function isCandidateId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_LENGTH && SHAPE.test(value);
}

export function candidateKindTraits(kind: CandidateKind): CandidateKindTraits {
  return CANDIDATE_KINDS[kind];
}

function isCandidateKind(value: string): value is CandidateKind {
  return Object.prototype.hasOwnProperty.call(CANDIDATE_KINDS, value);
}

export type ParsedCandidateId =
  | { kind: CandidateKind; asset: string; traits: CandidateKindTraits }
  | { kind: typeof REQUESTED_ACTIONS_ID; asset: null; traits: null };

/**
 * Null for anything this module did not mint: a malformed string, an unregistered kind,
 * or a registered kind with no asset. Callers treat null as "not proposed".
 */
export function parseCandidateId(id: string): ParsedCandidateId | null {
  if (!isCandidateId(id)) return null;
  if (id === REQUESTED_ACTIONS_ID) return { kind: REQUESTED_ACTIONS_ID, asset: null, traits: null };
  const at = id.indexOf(SEPARATOR);
  if (at < 0) return null;
  const kind = id.slice(0, at);
  const asset = id.slice(at + 1);
  if (!isCandidateKind(kind) || !asset) return null;
  return { kind, asset, traits: CANDIDATE_KINDS[kind] };
}

/** Blend goes through the margin account; Earn is spent from the G-wallet. Borrowing always needs margin. */
export function requiresMarginAccount(traits: CandidateKindTraits): boolean {
  return traits.borrows || traits.venue !== "earn";
}
