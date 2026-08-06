/**
 * One typed shape for "what the user wants to execute", validated at the boundary.
 *
 * ## The bug class this closes
 *
 * Three call sites independently hand-built a `CopilotAction`, each a list of
 * `x ?? null` lines:
 *
 *   handle.ts   routed → action          (router or LLM output)
 *   handle.ts   pending_write → action   (a resumed or clarified write)
 *   multi-leg   expanded → action        (one leg of a plan)
 *
 * …and two more places rebuilt the same content on the approve path: `freezePlan`
 * flattening a plan for display, and `verifyApprovedPlan` reconstructing it after the
 * user pressed Approve.
 *
 * A slot added to one of those five is dropped by the other four, silently, with no type
 * error — because "I forgot a line" and "this field is genuinely absent" are the same
 * `null` to every consumer. That is not a hypothetical:
 *
 *   leverage      dropped on approve replay → an approved "deploy 10 BLUSDC at 2×" ran
 *                 as a plain 1× supply. Fixed by adding a line.
 *   borrow_asset  dropped on approve replay → an approved "deposit 500 AQUSDC, borrow
 *                 XLM at 3×" ran as `borrow 1000 AQUSDC`: the DOLLAR size of the debt
 *                 spent as the wrong token. Fixed by adding a line.
 *   token_out     still dropped on approve replay at the time of writing.
 *
 * Each fix was correct and none of them fixed the next one. The defect is not any of
 * those fields; it is that the executable content of an action has no single definition,
 * so there is nowhere to add a field ONCE.
 *
 * ## How this file makes that structurally impossible
 *
 * {@link EXECUTABLE_SLOTS} is that definition. Everything that has to survive a hop
 * derives from it by iteration rather than by hand:
 *
 *   - `toSlots` / `slotsToAction`  the five conversion sites
 *   - `slotsFingerprint`           what approval hashes
 *   - `slotsAreEqual`              what replay is checked against
 *
 * So adding a slot is one entry in one array, and it is carried, hashed and replayed
 * everywhere at once. Forgetting to wire a new slot is no longer possible, because there
 * is no per-site wiring left to forget.
 *
 * ## Where validation happens
 *
 * At the two boundaries the plan names: model output, and a resume payload. Not on
 * internal hops — re-validating a value we produced ourselves only adds places to
 * disagree. `parseIntent` refuses an unresolvable asset where it ENTERS rather than
 * three hops later, and reports a bare "USDC" as its own outcome (`ambiguous`) rather
 * than as an error, because the product answer to that is a variant chip, not a failure.
 *
 * Hand-written: six-ish fields do not justify a schema dependency, and the bundle stays
 * where it is.
 */

import {
  isAmbiguousUsdc,
  resolveAsset,
  type AssetDef,
  type AssetId,
} from "./assets";
// Type-only: no runtime edge, so no import cycle with the module that consumes this.
import type { CopilotAction } from "../types";

/** DEX / lending venue an op can be pinned to. */
export const VENUE_IDS = ["aquarius", "soroswap", "blend", "earn", "margin"] as const;
export type VenueId = (typeof VENUE_IDS)[number];

/**
 * Every slot that changes what executes, and its kind.
 *
 * "Changes what executes" is the exact bar, and it is wider than "is an MCP argument":
 *
 *   asset..venue          reach `mapOpToMcpStep` and become MCP call arguments
 *   borrow_asset          decides whether `planLeverage` sizes cross-asset, which
 *                         decides borrow_amount — so it changes the trade without ever
 *                         being an argument itself. This is exactly the slot whose
 *                         "it's only for display" appearance let it be dropped.
 *   min_hf                the risk gate's block threshold
 *   prefer_max_yield      which venue gets picked
 *
 * Deliberately NOT here: `explain` (presentation), `requires_amount` /
 * `requires_account` / `multi_leg` (derived from op + amount), and `smart_account` /
 * `trader` (request context, not intent — they come from the session, and hashing them
 * would make a plan un-replayable from a different tab).
 */
export const EXECUTABLE_SLOTS = {
  asset: "asset",
  amount: "number",
  leverage: "number",
  borrow_asset: "asset",
  borrow_amount: "number",
  token_a: "asset",
  token_b: "asset",
  amount_a: "number",
  amount_b: "number",
  fraction: "number",
  venue: "venue",
  min_hf: "number",
  prefer_max_yield: "boolean",
} as const;

export type SlotName = keyof typeof EXECUTABLE_SLOTS;

/** Stable order for hashing and iteration. Sorted so it cannot depend on edit order. */
export const SLOT_NAMES: SlotName[] = (Object.keys(EXECUTABLE_SLOTS) as SlotName[]).sort();

export type SlotValue = string | number | boolean | null;

/**
 * The executable content of one step, as a flat record.
 *
 * The wire and hash form. `Intent` below is the same information grouped for humans;
 * this is the form that makes "carry every slot" a loop instead of a checklist.
 */
export type IntentSlots = Partial<Record<SlotName, SlotValue>>;

/** Grouped view of the same slots — what callers read and write. */
export interface Intent {
  op: string;
  collateral: { asset: AssetId | null; amount: number | null };
  /** null = borrow in the collateral asset (the common case). */
  borrow: { asset: AssetId | null; amount: number | null } | null;
  leverage: number | null;
  venue: VenueId | null;
  minHf: number | null;
  /**
   * LP pair legs, and — because `mapOpToMcpStep` reads the same two fields for a DEX
   * swap — the swap's token_in / token_out. One pair of slots, two products; keeping
   * them as one pair is what stops a swap's token_out being a fourth thing to forget.
   */
  pair: {
    tokenA: AssetId | null;
    tokenB: AssetId | null;
    amountA: number | null;
    amountB: number | null;
  } | null;
  /** e.g. 0.5 for "remove half my liquidity". */
  fraction: number | null;
  preferMaxYield: boolean | null;
}

// ── coercion helpers ────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function positive(v: unknown): number | null {
  const n = num(v);
  return n != null && n > 0 ? n : null;
}

function bool(v: unknown): boolean | null {
  if (v == null) return null;
  return v === true || v === "true" ? true : v === false || v === "false" ? false : null;
}

export function normalizeVenue(v: unknown): VenueId | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s.includes("soro")) return "soroswap";
  if (s.includes("aqua")) return "aquarius";
  if (s.includes("blend")) return "blend";
  if (s === "earn") return "earn";
  if (s === "margin") return "margin";
  return null;
}

/**
 * Resolve an asset slot, keeping the three outcomes distinct.
 *
 * `ambiguous` is not an error and must not be flattened into one: a bare "USDC" is a
 * question the product already knows how to ask. Collapsing it to null would silently
 * drop the user's word, and collapsing it to a guess would pick one of three tokens for
 * them.
 */
export type AssetSlot =
  | { kind: "asset"; id: AssetId }
  | { kind: "ambiguous"; options: AssetDef[] }
  | { kind: "absent" };

export function resolveAssetSlot(v: unknown): AssetSlot {
  const raw = String(v ?? "").trim();
  if (!raw) return { kind: "absent" };
  const m = resolveAsset(raw);
  if (m.kind === "asset") return { kind: "asset", id: m.def.id };
  if (m.kind === "ambiguous") return { kind: "ambiguous", options: m.options };
  return { kind: "absent" };
}

// ── slots ↔ intent ──────────────────────────────────────────────────────────

/**
 * Read an arbitrary producer's object into canonical slots.
 *
 * Accepts BOTH spellings for every slot that has ever had two — `args.leverage` and
 * `leverage`, `args.borrow_asset` and `borrow_asset`, `symbol` and `asset` — because
 * different producers spell them differently and picking one would drop the other. That
 * tolerance is precisely why reading has to be centralised: each of the five sites had
 * its own subset of the spellings.
 */
export function toSlots(raw: unknown): IntentSlots {
  const o = (raw ?? {}) as Record<string, unknown>;
  const args = (o.args ?? {}) as Record<string, unknown>;
  const pick = (k: string): unknown => (args[k] !== undefined ? args[k] : o[k]);

  /**
   * Alternative spellings of the SAME slot, by producer.
   *
   * A swap's `token_in`/`token_out` are `token_a`/`token_b` — `mapOpToMcpStep` reads one
   * pair of fields for both products. Not knowing that is exactly why token_out was the
   * next slot in line to be dropped: it never matched a slot name, so it was invisible
   * to anything iterating the list. `symbol` is mapOpToMcpStep's spelling of `asset`.
   */
  const ALIASES: Partial<Record<SlotName, string[]>> = {
    asset: ["symbol"],
    token_a: ["token_in"],
    token_b: ["token_out"],
  };

  const out: IntentSlots = {};
  for (const name of SLOT_NAMES) {
    const kind = EXECUTABLE_SLOTS[name];
    let v = pick(name);
    for (const alt of ALIASES[name] ?? []) {
      if (v == null || v === "") v = pick(alt);
    }
    if (v == null || v === "") continue;

    if (kind === "asset") {
      const slot = resolveAssetSlot(v);
      // An ambiguous "USDC" is preserved verbatim: the clarify flow needs to see the
      // user's own word to ask about it, and dropping it here is what turned a stated
      // asset into "which one did you mean?" about nothing.
      out[name] =
        slot.kind === "asset"
          ? slot.id
          : slot.kind === "ambiguous"
            ? "USDC"
            : String(v).toUpperCase();
    } else if (kind === "number") {
      const n = name === "min_hf" || name === "leverage" || name === "fraction" ? num(v) : positive(v);
      if (n != null) out[name] = n;
    } else if (kind === "venue") {
      const ven = normalizeVenue(v);
      if (ven) out[name] = ven;
    } else {
      const b = bool(v);
      if (b != null) out[name] = b;
    }
  }
  return out;
}

/** Drop empty slots so two spellings of "absent" hash identically. */
export function compactSlots(slots: IntentSlots): IntentSlots {
  const out: IntentSlots = {};
  for (const name of SLOT_NAMES) {
    const v = slots[name];
    if (v == null || v === "") continue;
    out[name] = v;
  }
  return out;
}

/** Canonical string for hashing / comparison. Key order is fixed by SLOT_NAMES. */
export function slotsFingerprint(slots: IntentSlots): string {
  return SLOT_NAMES.map((n) => {
    const v = slots[n];
    return `${n}=${v == null ? "" : String(v)}`;
  }).join("|");
}

/** True when two slot records would execute identically. */
export function slotsAreEqual(a: IntentSlots, b: IntentSlots): boolean {
  return slotsFingerprint(compactSlots(a)) === slotsFingerprint(compactSlots(b));
}

/** Which slots the second record is missing relative to the first. */
export function missingSlots(expected: IntentSlots, got: IntentSlots): SlotName[] {
  const e = compactSlots(expected);
  const g = compactSlots(got);
  return SLOT_NAMES.filter((n) => e[n] != null && g[n] == null);
}

export function slotsToIntent(op: string, slots: IntentSlots): Intent {
  const s = compactSlots(slots);
  const asAsset = (v: SlotValue | undefined): AssetId | null => {
    const slot = resolveAssetSlot(v);
    return slot.kind === "asset" ? slot.id : null;
  };
  const borrowAsset = asAsset(s.borrow_asset);
  const borrowAmount = num(s.borrow_amount);
  const tokenA = asAsset(s.token_a);
  const tokenB = asAsset(s.token_b);
  return {
    op,
    collateral: { asset: asAsset(s.asset), amount: num(s.amount) },
    borrow:
      s.borrow_asset != null || borrowAmount != null
        ? { asset: borrowAsset, amount: borrowAmount }
        : null,
    leverage: num(s.leverage),
    venue: normalizeVenue(s.venue),
    minHf: num(s.min_hf),
    pair:
      tokenA || tokenB || s.amount_a != null || s.amount_b != null
        ? {
            tokenA,
            tokenB,
            amountA: num(s.amount_a),
            amountB: num(s.amount_b),
          }
        : null,
    fraction: num(s.fraction),
    preferMaxYield: bool(s.prefer_max_yield),
  };
}

export function intentToSlots(intent: Intent): IntentSlots {
  return compactSlots({
    asset: intent.collateral.asset,
    amount: intent.collateral.amount,
    leverage: intent.leverage,
    borrow_asset: intent.borrow?.asset ?? null,
    borrow_amount: intent.borrow?.amount ?? null,
    token_a: intent.pair?.tokenA ?? null,
    token_b: intent.pair?.tokenB ?? null,
    amount_a: intent.pair?.amountA ?? null,
    amount_b: intent.pair?.amountB ?? null,
    fraction: intent.fraction,
    venue: intent.venue,
    min_hf: intent.minHf,
    prefer_max_yield: intent.preferMaxYield,
  });
}

// ── the one conversion ──────────────────────────────────────────────────────

/** Ops that do not need an amount to be executable. */
const AMOUNT_OPTIONAL = new Set([
  "create_account",
  "open_account",
  "close_account",
  "settle_account",
]);

/** Ops that run without a margin smart account. */
const NO_ACCOUNT_NEEDED = new Set(["create_account", "open_account", "lend", "redeem"]);

export interface ActionCtx {
  smartAccount: string | null;
  trader: string | null;
  /** Only used when the slots carry no min_hf of their own. */
  minHf?: number | null;
  explain?: boolean | null;
  multiLeg?: boolean;
}

/** The single Intent → CopilotAction conversion. Replaces all five hand-written ones. */
export function slotsToAction(op: string, slots: IntentSlots, ctx: ActionCtx): CopilotAction {
  const s = compactSlots(slots);
  const amount = num(s.amount);
  const fraction = num(s.fraction);
  return {
    op,
    asset: (s.asset as string) ?? null,
    amount,
    leverage: num(s.leverage),
    borrow_asset: (s.borrow_asset as string) ?? null,
    borrow_amount: num(s.borrow_amount),
    token_a: (s.token_a as string) ?? null,
    token_b: (s.token_b as string) ?? null,
    amount_a: num(s.amount_a),
    amount_b: num(s.amount_b),
    fraction,
    venue: (s.venue as string) ?? null,
    // Slot-level min_hf wins over the ambient one: a plan step that recorded a floor
    // carries the floor that was approved, not whatever the current message parses to.
    min_hf: num(s.min_hf) ?? ctx.minHf ?? null,
    prefer_max_yield: bool(s.prefer_max_yield),
    // Derived, never carried — see EXECUTABLE_SLOTS.
    requires_amount:
      !AMOUNT_OPTIONAL.has(op) &&
      amount == null &&
      !(op === "remove_liquidity" && fraction != null) &&
      // Repay "all" / "25%" is fraction against live debt — same as Margin 100% chip.
      !(op === "repay" && fraction != null),
    requires_account: !NO_ACCOUNT_NEEDED.has(op),
    multi_leg: !!ctx.multiLeg,
    smart_account: ctx.smartAccount,
    trader: ctx.trader,
    explain: ctx.explain ?? null,
  };
}

/** Convenience: read any producer's object and convert in one step. */
export function actionFrom(raw: unknown, ctx: ActionCtx): CopilotAction {
  const o = (raw ?? {}) as Record<string, unknown>;
  const op = String(o.op ?? o.tool ?? "");
  return slotsToAction(op, toSlots(o), ctx);
}

// ── boundary validation ─────────────────────────────────────────────────────

export type IntentInvalid =
  | { reason: "missing_op" }
  | { reason: "unknown_asset"; slot: SlotName; value: string }
  /** A bare "USDC" — ask which variant, do not fail. */
  | { reason: "ambiguous_asset"; slot: SlotName; options: AssetDef[] }
  | { reason: "bad_amount"; slot: SlotName; value: string }
  | { reason: "bad_leverage"; value: string };

export type IntentParse = { intent: Intent; slots: IntentSlots } | { invalid: IntentInvalid };

/** Slots whose asset must resolve to exactly one token before anything executes. */
const ASSET_SLOTS: SlotName[] = SLOT_NAMES.filter((n) => EXECUTABLE_SLOTS[n] === "asset");

/**
 * Validate what arrives from outside — model output, or a resume payload.
 *
 * Refuses at the boundary, which is the whole point: an unresolvable asset that gets in
 * here surfaces three hops later as a confusing question about a token nobody named.
 */
export function parseIntent(raw: unknown): IntentParse {
  const o = (raw ?? {}) as Record<string, unknown>;
  const op = String(o.op ?? o.tool ?? "").trim();
  if (!op) return { invalid: { reason: "missing_op" } };

  const args = (o.args ?? {}) as Record<string, unknown>;
  const pick = (k: string): unknown => (args[k] !== undefined ? args[k] : o[k]);

  // Uses the same alias-aware read as toSlots, so validation and carriage cannot
  // disagree about which fields exist.
  const slotsForCheck = toSlots(o);
  for (const slot of ASSET_SLOTS) {
    const v = slotsForCheck[slot];
    if (v == null || v === "") continue;
    const text = String(v);
    if (isAmbiguousUsdc(text)) {
      return { invalid: { reason: "ambiguous_asset", slot, options: resolveUsdcOptions() } };
    }
    if (resolveAssetSlot(text).kind !== "asset") {
      return { invalid: { reason: "unknown_asset", slot, value: text } };
    }
  }

  for (const slot of SLOT_NAMES) {
    if (EXECUTABLE_SLOTS[slot] !== "number") continue;
    const v = pick(slot);
    if (v == null || v === "") continue;
    const n = num(v);
    if (n == null) return { invalid: { reason: "bad_amount", slot, value: String(v) } };
    // Sizes must be positive; min_hf and leverage have their own rules below.
    if (n <= 0 && slot !== "min_hf" && slot !== "leverage") {
      return { invalid: { reason: "bad_amount", slot, value: String(v) } };
    }
  }

  const lev = num(pick("leverage"));
  if (lev != null && !(lev > 1)) {
    // 1× is not leverage, and 0 or a negative is meaningless — both would silently
    // produce a borrow leg of zero or a negative size.
    return { invalid: { reason: "bad_leverage", value: String(pick("leverage")) } };
  }

  const slots = toSlots(o);
  return { intent: slotsToIntent(op, slots), slots };
}

function resolveUsdcOptions(): AssetDef[] {
  const m = resolveAsset("USDC");
  return m.kind === "ambiguous" ? m.options : [];
}

/**
 * Lenient normalization for values WE produced.
 *
 * Internal hops do not re-validate — see the file header. This canonicalises spelling
 * and drops empties so a hash taken on either side of a hop matches.
 */
export function normalizeIntent(raw: unknown): { op: string; slots: IntentSlots } {
  const o = (raw ?? {}) as Record<string, unknown>;
  return { op: String(o.op ?? o.tool ?? ""), slots: toSlots(o) };
}
