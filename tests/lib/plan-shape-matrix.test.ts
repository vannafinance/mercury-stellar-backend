/**
 * The shape matrix — every cell of op × sizing × asset × funding state, GENERATED from the
 * vocabulary the model is given (`WORKFLOW_OPS`, `PLAN_SIZINGS`), the registry
 * (`ASSET_IDS`) and the op-flow table (`OP_FLOW`). Nothing here is a hand-picked prompt.
 *
 * ## Why
 *
 * 12–14 Sep the copilot was debugged one live prompt at a time: each prompt exercised one
 * cell of this grid, and every defect found was a cell nobody had typed yet ("repay 25%",
 * "lend 25% of xlm", a dust lend, a 14-decimal amount). A model that proposes shapes will
 * eventually propose every cell. So every cell is run here, and ONE invariant is asserted:
 *
 *   the sizer yields a fundable, precision-correct, allowlisted plan — or a refusal a
 *   person can read, that never came from a crash.
 *
 * A new op, sizing word or asset grows the grid by itself; the invariant still has to hold.
 */

import { describe, expect, it } from "vitest";
import { resolvePlans, type PlanContext } from "@/lib/copilot/investigation/plan";
import { compareObservedRates } from "@/lib/copilot/investigation/rate-comparison";
import { PLAN_SIZINGS } from "@/lib/copilot/investigation/decision";
import { decimalsFrom } from "@/lib/copilot/investigation/precision";
import { decimalWad, formatWad, mulDown, WAD } from "@/lib/copilot/investigation/fixed";
import type { Observation, PlanLeg, PlanSizing, ProposedPlan } from "@/lib/copilot/investigation/types";
import { ASSET_IDS, poolVenueFor, resolveAssetDef, swappableWith, type AssetId } from "@/lib/copilot/registry/assets";
import { allowedInvocation } from "@/lib/copilot/workflow/allowlist";
import { feeds, OP_FLOW, WORKFLOW_OPS, type Pocket, type WorkflowOp } from "@/lib/copilot/workflow/types";

const NOW = 1_700_000_000_000;
const SCOPE = {
  subject: "user", network: "testnet",
  trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA",
  smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC",
};
const NO_ACCOUNT = { ...SCOPE, smartAccount: null };

// ── the world: one funding state, built for one asset from the registry ─────────────────

const WALLET_STATES = ["empty", "dust", "funded"] as const;
const ACCOUNT_STATES = ["none", "floor", "no_floor"] as const;
interface World {
  wallet: (typeof WALLET_STATES)[number];
  earnPosition: boolean;
  blendPosition: boolean;
  lpPosition: boolean;
  collateral: boolean;
  debt: boolean;
  account: (typeof ACCOUNT_STATES)[number];
}
const WORLDS: World[] = WALLET_STATES.flatMap((wallet) => [false, true].flatMap((earnPosition) =>
  [false, true].flatMap((blendPosition) => [false, true].flatMap((lpPosition) => [false, true].flatMap((collateral) => [false, true].flatMap((debt) =>
    ACCOUNT_STATES.map((account) => ({ wallet, earnPosition, blendPosition, lpPosition, collateral, debt, account }))))))));

/** A price per oracle feed — the registry says which feed prices each asset. */
const FEED_PRICE = { XLM: "0.18", USDC: "1", AQUA: "0.002", EURC: "1.1" } as const;
const FUNDED = "1000";        // tokens in the wallet
const DUST = "0.01";          // worth less than the 0.5 XLM fee reserve at any feed price above
const POSTED = "800";         // tokens posted as collateral
const OWED = "300";           // tokens owed
const BLEND_SUPPLIED = "600";                 // what the account has sitting in the Blend farm
const LP_SHARES = "50";                       // LP shares held in the pair XLM is paired with
const VTOKENS = "500", UNDERLYING = "510.5"; // the Earn position, as the vToken read states it

const obs = (id: string, capability: string, data: Record<string, unknown>, args: Record<string, unknown> = {}): Observation =>
  ({ id, capability, args, observedAt: NOW, status: "ok", data });

function observations(asset: AssetId, world: World): Observation[] {
  const def = resolveAssetDef(asset)!;
  const balance = world.wallet === "funded" ? FUNDED : world.wallet === "dust" ? DUST : "0";
  const rows: Observation[] = [
    obs("w", "wallet_balances", {
      assets: [
        ...ASSET_IDS.map((id) => ({ symbol: id, balance: id === asset ? balance : "0", decimals: 7, status: "ok" })),
        { symbol: "XLM_SAC", balance: asset === "XLM" ? balance : "0", decimals: 7, status: "ok" },
      ],
      fee_reserve_xlm: "0.5",
    }),
    ...ASSET_IDS.map((id) => obs(`p-${id}`, "asset_price", { price_usd: FEED_PRICE[resolveAssetDef(id)!.oracleSymbol] }, { asset: id })),
    ...ASSET_IDS.filter((id) => resolveAssetDef(id)!.earnSymbol).map((id) =>
      obs(`m-${id}`, "earn_market", { supply_apr_pct: "5", borrow_apr_pct: "8", utilization_pct: "62.5" }, { asset: id })),
    // Rates the cross-check accepts (supply = borrow × utilisation), and Blend paying more than
    // Earn charges, as testnet does (168% vs 8% on 13 Sep): a levered supply has a carry.
    obs("b", "blend_markets", { reserves: ASSET_IDS.filter((id) => resolveAssetDef(id)!.blendReserve).map((id) =>
      ({ venue: "blend", symbol: resolveAssetDef(id)!.marginSymbol, supply_apr_pct: "12", borrow_apr_pct: "16", utilization_pct: "75" })) }),
  ];
  if (world.earnPosition && def.earnSymbol) {
    rows.push(obs("ep", "earn_position", { symbol: def.earnSymbol, vtoken_symbol: `V${def.earnSymbol}`, decimals: 7, human: VTOKENS, redeemable_human: UNDERLYING }, { asset }));
  }
  if (world.blendPosition && def.blendReserve) {
    rows.push(obs("bp", "blend_position", { positions: [{ venue: "blend", symbol: def.marginSymbol, underlying_value: BLEND_SUPPLIED }] }));
  }
  if (world.lpPosition && def.lpVenue) {
    rows.push(obs("lp", "farm_lp_position", {
      venue: def.lpVenue, token_a: "XLM", token_b: def.marginSymbol, lp_shares_human: LP_SHARES, lp_shares_raw: "500000000", decimals: 7,
    }, { asset }));
  }
  if (world.account !== "none") {
    rows.push(obs("ac", "account_collateral", { collateral: world.collateral && def.marginSymbol ? [{ symbol: def.marginSymbol, balance: POSTED }] : [] }));
    rows.push(obs("ad", "account_debt", { debt: world.debt && def.marginSymbol ? [{ symbol: def.marginSymbol, balance: OWED }] : [] }));
  }
  // Live reserves for any asset paired with XLM on Aquarius, keyed the way `plan.ts` reads
  // them — by the pool's non-XLM side — so add_liquidity can size the paired amount here
  // exactly as it would from the real MCP read, in every world, not just a hand-picked one.
  if (poolVenueFor("XLM", asset) === "aquarius") {
    rows.push(obs("res", "aquarius_pool_reserves",
      { found: true, pool: { available: true, reserves: { XLM: "10000", [asset]: "1800" }, total_share: "5000", fee: "0.0030" } },
      { asset }));
  }
  return rows;
}

/** One world is read once; only the user's words differ from cell to cell. */
const worlds = new Map<string, Omit<PlanContext, "messages">>();
function context(asset: AssetId, world: World, messages: string[]): PlanContext {
  const key = `${asset}|${world.wallet}|${world.earnPosition}|${world.blendPosition}|${world.lpPosition}|${world.collateral}|${world.debt}|${world.account}`;
  let base = worlds.get(key);
  if (!base) {
    const rows = observations(asset, world);
    const price = decimalWad(FEED_PRICE[resolveAssetDef(asset)!.oracleSymbol]);
    const usd = (tokens: string) => formatWad(mulDown(decimalWad(tokens), price, WAD));
    base = {
      scope: world.account === "none" ? NO_ACCOUNT : SCOPE,
      observations: rows, now: NOW,
      capacity: world.account === "none" ? null : {
        grossCollateralUsd: world.collateral ? usd(POSTED) : "0",
        debtUsd: world.debt ? usd(OWED) : "0",
        floor: world.account === "floor" ? "1.3" : null,
      },
      borrowing: "allowed",
      comparisons: compareObservedRates(rows, NOW),
    };
    worlds.set(key, base);
  }
  return { ...base, messages };
}

// ── the legs: every sizing word, in every form it takes ─────────────────────────────────

/** The sizing variants a word has, with the words the user would have said for it. */
function sizingsOf(kind: (typeof PLAN_SIZINGS)[number], asset: AssetId): Array<{ sizing: PlanSizing; said: string; tag: string }> {
  switch (kind) {
    case "literal": return [
      { sizing: { kind, amount: "100", sourceQuote: `100 ${asset}` }, said: `100 ${asset}`, tag: "literal:100" },
      { sizing: { kind, amount: "999999", sourceQuote: `999999 ${asset}` }, said: `999999 ${asset}`, tag: "literal:over" },
    ];
    case "fraction": return [
      { sizing: { kind, percent: "25", of: "idle", sourceQuote: `25% of my ${asset}` }, said: `25% of my ${asset}`, tag: "fraction:idle" },
      { sizing: { kind, percent: "25", of: "position", sourceQuote: `25% of my ${asset}` }, said: `25% of my ${asset}`, tag: "fraction:position" },
    ];
    // As a lone single-leg cell this always refuses (no preceding deposit to multiply) —
    // the happy path needs two legs and is covered by plan-resolve.test.ts's own suite;
    // this only proves the refusal is clean, not a crash, on every op the matrix tries it on.
    case "leverage": return [{ sizing: { kind, multiple: "6", sourceQuote: `6x leverage on ${asset}` }, said: `6x leverage on ${asset}`, tag: "leverage:6" }];
    default: return [{ sizing: { kind } as PlanSizing, said: `all my ${asset}`, tag: kind }];
  }
}

/** The one sizing word that draws on an op's own source pocket — how a first leg is naturally sized. */
function naturalSizing(op: WorkflowOp, asset: AssetId): { sizing: PlanSizing; said: string } {
  const flow = OP_FLOW[op];
  if (flow.from === "wallet") return { sizing: { kind: "all_idle" }, said: `all my ${asset}` };
  if (flow.from === "debt") return { sizing: { kind: "to_floor" }, said: `as much ${asset} as the floor allows` };
  if (flow.positionRead) return { sizing: { kind: "all_position" }, said: `all my ${asset}` };
  return { sizing: { kind: "literal", amount: "100", sourceQuote: `100 ${asset}` }, said: `100 ${asset}` };
}

/**
 * A swap needs the asset it buys; add_liquidity needs the pool's other token. Any other
 * margin-accepted asset will do for a swap — the point of the grid is the sizing and
 * funding rules, not which pair was chosen — but add_liquidity's rejects on anything that
 * isn't a real pool partner, so it always takes the tradable one when there is one.
 */
function withOut(op: WorkflowOp, asset: AssetId): { assetOut?: string } {
  if (op !== "swap" && op !== "add_liquidity") return {};
  // Prefer an asset a pool actually trades this one against, so the cell exercises sizing
  // rather than stopping at "no pool trades …"; fall back to any other margin asset so the
  // untradable pairs are covered too.
  const tradable = swappableWith(asset)[0];
  const other = tradable ?? ASSET_IDS.find((id) => id !== asset && resolveAssetDef(id)!.marginSymbol);
  return other ? { assetOut: other } : {};
}

interface Cell { title: string; legs: PlanLeg[]; said: string }
function cells(asset: AssetId): Cell[] {
  const single = WORKFLOW_OPS.flatMap((op) => PLAN_SIZINGS.flatMap((kind) => sizingsOf(kind, asset).map(({ sizing, said, tag }) =>
    ({ title: `${op} ${asset} ${tag}`, legs: [{ op, asset, sizing, ...withOut(op, asset) }], said }))));
  // Every ordered pair, the second leg taking what the first leaves: `previous_leg` in every position it can appear.
  const pairs = WORKFLOW_OPS.flatMap((first) => WORKFLOW_OPS.map((second) => {
    const natural = naturalSizing(first, asset);
    return { title: `${first} → ${second} ${asset}`, said: natural.said,
      legs: [{ op: first, asset, sizing: natural.sizing, ...withOut(first, asset) },
             { op: second, asset, sizing: { kind: "previous_leg" } as PlanSizing, ...withOut(second, asset) }] };
  }));
  /**
   * Every ordered pair where BOTH legs size themselves from the same source, rather than
   * the second taking what the first produced. 14 Sep: the matrix had only `previous_leg`
   * pairs, so it never generated "deposit all idle XLM, then repay all the debt" — a plan
   * that spent the same 3,315 XLM twice and was caught only at approve time.
   */
  const sameSource = WORKFLOW_OPS.flatMap((first) => WORKFLOW_OPS.flatMap((second) => {
    const a = naturalSizing(first, asset), b = naturalSizing(second, asset);
    return [{ title: `${first} + ${second} ${asset} (both from source)`, said: `${a.said} ${b.said}`,
      legs: [{ op: first, asset, sizing: a.sizing, ...withOut(first, asset) },
             { op: second, asset, sizing: b.sizing, ...withOut(second, asset) }] }];
  }));
  /**
   * Deposit, then borrow the SAME asset at a stated multiple, then cover it with a supply —
   * the one shape leverage sizing exists for. Not reachable by `pairs`/`sameSource` at all:
   * both build every second leg from `naturalSizing`/`previous_leg`, never a stated
   * multiple, so leverage's own happy path needed its own generator or the matrix would
   * try the sizing word 30,240+ times and never once actually size it (15 Sep).
   */
  const leveraged: Cell[] = [{
    title: `deposit_collateral → borrow ${asset} leverage:6 → supply_blend`,
    said: `100 ${asset} at 6x leverage`,
    legs: [
      { op: "deposit_collateral", asset, sizing: { kind: "literal", amount: "100", sourceQuote: `100 ${asset}` } },
      { op: "borrow", asset, sizing: { kind: "leverage", multiple: "6", sourceQuote: "6x leverage" } },
      { op: "supply_blend", asset, sizing: { kind: "previous_leg" } },
    ],
  }];
  /**
   * Deposit, then add it to the pool as previous_leg — add_liquidity's own happy path, not
   * reachable by `pairs` either: the paired amount only sizes off live reserves, and only
   * for a real pool partner, so a generic second leg picked by `naturalSizing` never lands
   * here (15 Sep, same gap leverage sizing had — see `leveraged` above). Gated on the
   * registry actually pairing this asset with XLM on Aquarius, not a named asset.
   */
  const pooled: Cell[] = poolVenueFor("XLM", asset) === "aquarius" ? [{
    title: `deposit_collateral → add_liquidity ${asset}`,
    said: `100 ${asset} into the pool`,
    legs: [
      { op: "deposit_collateral", asset, sizing: { kind: "literal", amount: "100", sourceQuote: `100 ${asset}` } },
      { op: "add_liquidity", asset, sizing: { kind: "previous_leg" }, ...withOut("add_liquidity", asset) },
    ],
  }] : [];
  return [...single, ...pairs, ...sameSource, ...leveraged, ...pooled];
}

// ── the invariant ───────────────────────────────────────────────────────────────────────

/** The sizer's own "something threw" fallback: a cell that lands here crashed, whatever the words. */
const CRASH = "this plan could not be sized from the reads that completed";
/** A refusal is a sentence for a person: no codes, no leaked JS values. */
const NOT_FOR_PEOPLE = /undefined|NaN|\bnull\b|\[object|TypeError|RangeError|Cannot read|is not a function|\w+_\w+_\w+/;

/** What the world holds in each pocket for the asset, in tokens — the balances a plan may spend. */
function pockets(asset: AssetId, world: World): Record<Pocket, bigint> {
  const held = world.wallet === "funded" ? FUNDED : world.wallet === "dust" ? DUST : "0";
  const spendable = asset === "XLM" && decimalWad(held) > decimalWad("0.5") ? decimalWad(held) - decimalWad("0.5") : decimalWad(held);
  return {
    wallet: spendable,
    earn: world.earnPosition ? decimalWad(VTOKENS) : BigInt(0),
    blend: world.blendPosition && resolveAssetDef(asset)!.blendReserve ? decimalWad(BLEND_SUPPLIED) : BigInt(0),
    lp: world.lpPosition && resolveAssetDef(asset)!.lpVenue ? decimalWad(LP_SHARES) : BigInt(0),
    account: world.account !== "none" && world.collateral ? decimalWad(POSTED) : BigInt(0),
    debt: world.account !== "none" && world.debt ? decimalWad(OWED) : BigInt(0),
  };
}

function checkCell(asset: AssetId, world: World, cell: Cell): "plan" | "refusal" {
  const ctx = context(asset, world, [`${cell.said} — ${cell.title}`]);
  const plan: ProposedPlan = { title: cell.title, rationale: "matrix", evidenceIds: ["w"], legs: cell.legs };
  const label = `${cell.title} | wallet=${world.wallet} earn=${world.earnPosition} blend=${world.blendPosition} lp=${world.lpPosition} coll=${world.collateral} debt=${world.debt} account=${world.account}`;
  const { candidates, rejected } = resolvePlans([plan], ctx);
  expect(candidates.length + rejected.length, label).toBe(1);

  if (rejected.length) {
    const reason = rejected[0].reason;
    expect(reason, label).not.toBe(CRASH);
    expect(reason, label).not.toMatch(NOT_FOR_PEOPLE);
    expect(reason.split(/\s+/).length, label).toBeGreaterThanOrEqual(3);
    return "refusal";
  }

  const candidate = candidates[0];
  const steps = candidate.steps ?? [];
  expect(steps.length, label).toBeGreaterThan(0);
  const decimals = decimalsFrom(ctx.observations);
  const funds = pockets(asset, world);
  for (const step of steps) {
    const amount = decimalWad(step.amount);
    expect(amount > BigInt(0), `${label}: ${step.id} amount ${step.amount}`).toBe(true);
    // Precision: never finer than the read stated for the token the tool is called with.
    const places = decimals.get(String(step.args.symbol)) ?? decimals.get(step.asset);
    expect(places, `${label}: ${step.id} precision for ${String(step.args.symbol)}`).toBeDefined();
    expect(step.amount.split(".")[1]?.length ?? 0, `${label}: ${step.id} ${step.amount}`).toBeLessThanOrEqual(places!);
    // Allowlisted: the exact tool and argument set the protocol accepts, nothing else.
    expect(() => allowedInvocation(step, ctx.scope), `${label}: ${step.id}`).not.toThrow();
    // Fundable: the op-flow table's source pocket holds it, after everything before it ran.
    const { from, to } = OP_FLOW[step.op];
    if (from !== "debt") {
      expect(funds[from] >= amount, `${label}: ${step.id} spends ${step.amount} from ${from} holding ${formatWad(funds[from])}`).toBe(true);
      funds[from] -= amount;
    }
    // A redeem is called with vTokens and lands the underlying, pro rata to the position read.
    const lands = from === "earn" ? (amount * decimalWad(UNDERLYING)) / decimalWad(VTOKENS) : amount;
    if (to === "debt") {
      expect(funds.debt >= lands, `${label}: ${step.id} repays ${step.amount} of ${formatWad(funds.debt)} owed`).toBe(true);
      funds.debt -= lands;
    } else {
      funds[to] += lands;
    }
  }
  // A floor the user stated is a stop condition on every plan that can lower health.
  const floor = ctx.capacity?.floor;
  if (floor && steps.some((s) => OP_FLOW[s.op].health === "lowers") && candidate.finalHealthFactor !== null) {
    expect(decimalWad(candidate.finalHealthFactor) >= decimalWad(floor), `${label}: HF ${candidate.finalHealthFactor} under floor ${floor}`).toBe(true);
  }
  return "plan";
}

// ── run it ──────────────────────────────────────────────────────────────────────────────

describe("the shape matrix — every op × sizing × asset × funding state", () => {
  const grid = ASSET_IDS.flatMap((asset) => cells(asset).flatMap((cell) => WORLDS.map((world) => ({ asset, cell, world }))));
  const outcomes = { plan: 0, refusal: 0 };
  const plansBy = { op: new Set<WorkflowOp>(), sizing: new Set<string>(), asset: new Set<AssetId>() };

  // One test per first op, so a failing cell is named by its op and the clock runs per slice.
  describe.each(WORKFLOW_OPS)("%s", (op) => {
    const slice = grid.filter(({ cell }) => cell.legs[0].op === op);
    it(`holds the invariant on every one of its ${slice.length} cells (of ${grid.length})`, () => {
      for (const { asset, cell, world } of slice) {
        const outcome = checkCell(asset, world, cell);
        outcomes[outcome] += 1;
        if (outcome === "plan") {
          for (const leg of cell.legs) { plansBy.op.add(leg.op); plansBy.sizing.add(leg.sizing.kind); }
          plansBy.asset.add(asset);
        }
      }
    }, 120_000);
  });

  // 14 Sep: 1,880 plans and 51,040 refusals out of 52,920 cells.
  it("is not vacuous: plans came out of the grid, and refusals too", () => {
    expect(outcomes.plan).toBeGreaterThan(0);
    expect(outcomes.refusal).toBeGreaterThan(0);
  });

  it("offers at least one plan for every op, every sizing word and every asset the protocol accepts", () => {
    expect([...plansBy.op].sort()).toEqual([...WORKFLOW_OPS].sort());
    expect([...plansBy.sizing].sort()).toEqual([...PLAN_SIZINGS].sort());
    // Assets with neither an Earn pool nor a margin symbol can only be refused — by the registry, not by a crash.
    const accepted = ASSET_IDS.filter((id) => resolveAssetDef(id)!.earnSymbol || resolveAssetDef(id)!.marginSymbol);
    expect([...plansBy.asset].sort()).toEqual([...accepted].sort());
  });

  it("hands a leg to the next one only where the table says the tokens went", () => {
    // Fixed properties of the table the matrix relies on — if these change, the grid's meaning changes.
    for (const op of WORKFLOW_OPS) {
      const takers = WORKFLOW_OPS.filter((next) => feeds(op, next));
      const left = OP_FLOW[op].to;
      // Tokens hand over; a position (Earn, Blend, a shrunken debt) is not an amount the next tool takes.
      if (left === "wallet" || left === "account") {
        expect(takers.length).toBeGreaterThan(0);
        expect(takers.every((next) => OP_FLOW[next].from === left)).toBe(true);
      } else {
        expect(takers).toEqual([]);
      }
    }
  });
});
