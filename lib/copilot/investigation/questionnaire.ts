/**
 * A direct action with missing inputs becomes a questionnaire. Options come from
 * the op-flow table and the registry, never from a written list of venues or pools.
 */
import { createHash } from "node:crypto";
import { BALANCE_FRACTION_OPTIONS } from "../amount-intent";
import { allAssets, lpPairs, mentionsBareUsdc, resolveAssetDef, USDC_VARIANTS, type AssetId } from "../registry/assets";
import { deploysIntoPosition, OP_FLOW, WORKFLOW_OPS, type Pocket, type WorkflowOp } from "../workflow/types";
import { verbOf } from "./plan";
import { decimalWad, formatWad, WAD, ZERO } from "./fixed";
import { poolReservesFrom } from "./pool-quote";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
import type { Observation, PlanLeg, StatedAction } from "./types";
import type { Questionnaire, QuestionnaireAnswers, QuestionnaireOption, QuestionnaireStep } from "./view";
import type { StrategyRead } from "./strategy-reads";

export interface QuestionnaireMissing {
  op?: WorkflowOp;
  /** A registry id, or a bare family the user said ("USDC"). */
  asset?: string;
  slots: Array<"asset" | "venue" | "amount">;
}

const SLOTS = ["asset", "venue", "amount"] as const;
const POCKET_WHERE: Record<Pocket, string> = {
  wallet: "wallet",
  account: "the margin account",
  earn: "Earn",
  blend: "Blend",
  lp: "the pool",
  debt: "debt",
};

export function parseQuestionnaireMissing(value: unknown): QuestionnaireMissing | null {
  if (!isRecord(value) || !Array.isArray(value.slots) || value.slots.length === 0) return null;
  const slots: QuestionnaireMissing["slots"] = [];
  for (const slot of value.slots) {
    if (slot !== "asset" && slot !== "venue" && slot !== "amount") return null;
    if (!slots.includes(slot)) slots.push(slot);
  }
  if (!slots.length) return null;
  let op: WorkflowOp | undefined;
  if (value.op !== undefined) {
    if (!(WORKFLOW_OPS as readonly string[]).includes(String(value.op))) return null;
    op = value.op as WorkflowOp;
  }
  let asset: string | undefined;
  if (value.asset !== undefined) {
    if (typeof value.asset !== "string" || !value.asset.trim()) return null;
    asset = value.asset.trim();
  }
  return { ...(op ? { op } : {}), ...(asset ? { asset } : {}), slots };
}

function namedAsset(asset: string | undefined): AssetId | null {
  if (!asset || asset.toUpperCase() === "USDC" || mentionsBareUsdc(asset)) return null;
  return resolveAssetDef(asset)?.id ?? null;
}

function familyNarrows(asset: string | undefined): boolean {
  return !!asset && (asset.toUpperCase() === "USDC" || mentionsBareUsdc(asset)) && !namedAsset(asset);
}

/** The ops this question is choosing among. A named op is the only one. */
export function opsInPlay(missing: QuestionnaireMissing): WorkflowOp[] {
  if (missing.op) return [missing.op];
  return WORKFLOW_OPS.filter((op) => deploysIntoPosition(op));
}

export function assetsAccepted(op: WorkflowOp): AssetId[] {
  const flow = OP_FLOW[op];
  if (flow.to === "lp" || flow.from === "lp") {
    return [...new Set(lpPairs().flatMap((pair) => pair.tokens))];
  }
  return allAssets().filter((def) => {
    if (flow.to === "earn" || flow.from === "earn") return !!def.earnSymbol;
    if (flow.to === "blend" || flow.from === "blend") return def.blendReserve;
    return !!def.marginSymbol;
  }).map((def) => def.id);
}

function candidateAssets(missing: QuestionnaireMissing, ops: readonly WorkflowOp[]): AssetId[] {
  const accepted = [...new Set(ops.flatMap(assetsAccepted))];
  const named = namedAsset(missing.asset);
  if (named) return accepted.filter((id) => id === named);
  if (familyNarrows(missing.asset)) return accepted.filter((id) => (USDC_VARIANTS as readonly string[]).includes(id));
  return accepted;
}

function positive(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const wad = decimalWad(String(value));
    return wad > ZERO ? formatWad(wad) : null;
  } catch { return null; }
}

function rowBalance(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const amount = positive(row[key]);
    if (amount) return amount;
  }
  return null;
}

/** The amount of `asset` sitting in `pocket`, from a fresh read. Null when that read is absent. */
export function heldInPocket(observations: readonly Observation[], pocket: Pocket, asset: AssetId): string | null {
  const def = resolveAssetDef(asset);
  if (!def) return null;
  const symbol = def.marginSymbol ?? def.id;
  if (pocket === "wallet") {
    for (const observation of observations) {
      if (observation.capability !== "wallet_balances" || observation.status !== "ok" || !Array.isArray(observation.data?.assets)) continue;
      for (const row of observation.data.assets) {
        if (!isRecord(row) || row.symbol !== asset) continue;
        return rowBalance(row, ["balance", "spendable"]);
      }
      return null;
    }
    return null;
  }
  const capability = pocket === "account" ? "account_collateral"
    : pocket === "debt" ? "account_debt"
      : pocket === "earn" ? "earn_position"
        : pocket === "blend" ? "blend_position"
          : "farm_lp_position";
  const observation = [...observations].reverse().find((item) => item.capability === capability && (capability === "account_collateral" || capability === "account_debt" || capability === "blend_position" || item.args.asset === asset));
  if (!observation || observation.status !== "ok" || !observation.data) return null;
  if (capability === "earn_position") return rowBalance(observation.data, ["redeemable_human", "human", "balance"]);
  if (capability === "farm_lp_position") return rowBalance(observation.data, ["lp_shares_human", "balance"]);
  const rows = observation.data.collateral ?? observation.data.debt ?? observation.data.positions ?? observation.data.balances;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (row.symbol !== symbol && row.symbol !== asset && row.asset !== asset) continue;
    return rowBalance(row, ["balance", "underlying_value", "amount"]);
  }
  return null;
}

function readMissing(observations: readonly Observation[], capability: string): boolean {
  return !observations.some((item) => item.capability === capability && item.status === "ok" && item.data);
}

export function readsForQuestionnaire(missing: QuestionnaireMissing, observations: readonly Observation[], now: number): StrategyRead[] {
  const fresh = (capability: string, asset?: string) => observations.some((item) =>
    item.capability === capability && item.status === "ok" && item.data && now - item.observedAt <= 60_000 &&
    (asset === undefined || item.args.asset === asset));
  const wanted = new Map<string, StrategyRead>();
  const want = (capability: string, asset?: string) => {
    if (fresh(capability, asset)) return;
    wanted.set(`${capability}:${asset ?? ""}`, { capability, args: asset ? { asset } : {} });
  };
  const ops = opsInPlay(missing);
  const assets = candidateAssets(missing, ops);
  for (const op of ops) {
    const flow = OP_FLOW[op];
    if (flow.from === "wallet" || flow.to === "wallet") want("wallet_balances");
    if (flow.from === "account" || flow.to === "account") want("account_collateral");
    if (flow.from === "debt" || flow.to === "debt") want("account_debt");
    if (flow.positionRead === "earn_position" || flow.positionRead === "farm_lp_position") {
      for (const asset of assets) want(flow.positionRead, asset);
    } else if (flow.positionRead) want(flow.positionRead);
    if (flow.rate === "earn_supply" || flow.rate === "earn_borrow") {
      for (const asset of assets) want("earn_market", asset);
    }
    if (flow.rate === "blend_supply") want("blend_markets");
    if (flow.to === "lp" || flow.from === "lp") {
      for (const pair of lpPairs()) {
        if (!pair.tokens.some((token) => assets.includes(token))) continue;
        want(pair.venue === "soroswap" ? "soroswap_pool_reserves" : "aquarius_pool_reserves", pair.tokens[1]);
      }
    }
  }
  return [...wanted.values()];
}

function earnRate(observations: readonly Observation[], asset: AssetId): string | null {
  const row = [...observations].reverse().find((item) => item.capability === "earn_market" && item.status === "ok" && item.args.asset === asset);
  const rate = row?.data?.supply_apr_pct ?? row?.data?.supply_apy_pct;
  return typeof rate === "string" || typeof rate === "number" ? `${rate}% APY` : null;
}

function blendRate(observations: readonly Observation[], asset: AssetId): string | null {
  const symbol = resolveAssetDef(asset)?.marginSymbol ?? asset;
  for (const observation of observations) {
    if (observation.capability !== "blend_markets" || observation.status !== "ok") continue;
    const reserves = observation.data?.reserves;
    if (!Array.isArray(reserves)) continue;
    for (const row of reserves) {
      if (!isRecord(row) || (row.symbol !== symbol && row.symbol !== asset)) continue;
      const rate = row.supply_apr_pct ?? row.supply_apy_pct;
      if (typeof rate === "string" || typeof rate === "number") return `${rate}% APY`;
    }
  }
  return null;
}

function reservesFor(observations: readonly Observation[], venue: "aquarius" | "soroswap", quote: AssetId) {
  const capability = venue === "soroswap" ? "soroswap_pool_reserves" : "aquarius_pool_reserves";
  const row = [...observations].reverse().find((item) => item.capability === capability && item.status === "ok" && item.args.asset === quote);
  return row ? poolReservesFrom(row.data) : null;
}

interface VenueChoice {
  option: QuestionnaireOption;
  pocket: Pocket;
  pool?: { venue: "aquarius" | "soroswap"; tokens: [AssetId, AssetId] };
}

function venueChoices(asset: AssetId, ops: readonly WorkflowOp[], observations: readonly Observation[]): VenueChoice[] {
  const choices: VenueChoice[] = [];
  for (const op of ops) {
    const flow = OP_FLOW[op];
    if (!assetsAccepted(op).includes(asset)) continue;
    const held = heldInPocket(observations, flow.from, asset);
    if (!held) continue;
    if (deploysIntoPosition(op) && flow.to === "earn" && resolveAssetDef(asset)?.earnSymbol) {
      const rate = earnRate(observations, asset);
      choices.push({
        pocket: flow.from,
        option: { id: op, label: "Earn", forAsset: asset, op, ...(rate ? { detail: rate } : {}) },
      });
    } else if (deploysIntoPosition(op) && flow.to === "blend" && resolveAssetDef(asset)?.blendReserve) {
      const rate = blendRate(observations, asset);
      choices.push({
        pocket: flow.from,
        option: { id: op, label: "Farm · Blend", forAsset: asset, op, ...(rate ? { detail: rate } : {}) },
      });
    } else if (deploysIntoPosition(op) && flow.to === "lp") {
      for (const pair of lpPairs()) {
        if (!pair.tokens.includes(asset)) continue;
        const other = pair.tokens[0] === asset ? pair.tokens[1] : pair.tokens[0];
        const otherHeld = heldInPocket(observations, flow.from, other);
        const label = pair.venue === "aquarius" ? `Aquarius ${pair.tokens.join("/")} pool` : `Soroswap ${pair.tokens.join("/")} pool`;
        choices.push({
          pocket: flow.from,
          pool: pair,
          option: {
            id: `${op}:${pair.venue}`,
            label,
            forAsset: asset,
            op,
            detail: `pairs with ${other}${otherHeld ? ` · you have ${otherHeld} ${other}` : ""}`,
          },
        });
      }
    } else if (!deploysIntoPosition(op)) {
      choices.push({
        pocket: flow.from,
        option: { id: op, label: verbOf(op), forAsset: asset, op, detail: `${held} in ${POCKET_WHERE[flow.from]}` },
      });
    }
  }
  return choices;
}

function heldFor(asset: AssetId, ops: readonly WorkflowOp[], observations: readonly Observation[]): { amount: string; pocket: Pocket } | null {
  for (const op of ops) {
    if (!assetsAccepted(op).includes(asset)) continue;
    const amount = heldInPocket(observations, OP_FLOW[op].from, asset);
    if (amount) return { amount, pocket: OP_FLOW[op].from };
  }
  return null;
}

function perUnit(reserves: { xlm: string; paired: string }, assetIsBase: boolean): string | null {
  try {
    const base = decimalWad(reserves.xlm);
    const quote = decimalWad(reserves.paired);
    if (base <= ZERO || quote <= ZERO) return null;
    return formatWad(assetIsBase ? (quote * WAD) / base : (base * WAD) / quote);
  } catch { return null; }
}

function capByPair(held: string, otherHeld: string | null, unit: string | null): string {
  if (!otherHeld || !unit) return held;
  try {
    const other = decimalWad(otherHeld);
    const each = decimalWad(unit);
    if (each <= ZERO) return held;
    const capped = (other * WAD) / each;
    const own = decimalWad(held);
    return formatWad(capped < own ? capped : own);
  } catch { return held; }
}

function titleFor(missing: QuestionnaireMissing, ops: readonly WorkflowOp[]): string {
  const family = familyNarrows(missing.asset) ? "USDC" : namedAsset(missing.asset);
  const verb = ops.length === 1 ? verbOf(ops[0]) : "Supply";
  return family ? `${verb} ${family}` : verb;
}

export function buildQuestionnaire(missing: QuestionnaireMissing, observations: readonly Observation[], now: number): Questionnaire | null {
  void now;
  if (!missing.slots.length) return null;
  const ops = opsInPlay(missing);
  const assets = candidateAssets(missing, ops);
  const steps: QuestionnaireStep[] = [];
  let chosen = namedAsset(missing.asset);

  if (missing.slots.includes("asset")) {
    const pockets = [...new Set(ops.map((op) => OP_FLOW[op].from))];
    const unread = pockets.length > 0 && pockets.every((pocket) => readMissing(observations, pocket === "wallet" ? "wallet_balances" : pocket === "account" ? "account_collateral" : pocket === "earn" ? "earn_position" : pocket === "blend" ? "blend_position" : pocket === "debt" ? "account_debt" : "farm_lp_position"));
    const options: QuestionnaireOption[] = [];
    if (!unread) {
      for (const asset of assets) {
        const held = heldFor(asset, ops, observations);
        if (!held) continue;
        options.push({ id: asset, label: asset, detail: `${held.amount} in ${POCKET_WHERE[held.pocket]}` });
      }
    }
    if (options.length === 1) chosen = options[0].id as AssetId;
    steps.push({
      slot: "asset",
      prompt: unread ? "Balances could not be read, so say which asset you mean." : "Which asset?",
      options,
    });
  }

  const venueAssets = chosen ? [chosen] : assets;
  const venueOptions: QuestionnaireOption[] = [];
  const pair: Record<string, { asset: string; perUnit: string | null }> = {};
  const max: Record<string, { amount: string; asset: string; where: string }> = {};
  for (const asset of venueAssets) {
    for (const choice of venueChoices(asset, ops, observations)) {
      venueOptions.push(choice.option);
      const held = heldInPocket(observations, choice.pocket, asset);
      if (held) max[choice.option.id] = { amount: held, asset, where: POCKET_WHERE[choice.pocket] };
      if (choice.pool && held) {
        const other = choice.pool.tokens[0] === asset ? choice.pool.tokens[1] : choice.pool.tokens[0];
        const reserves = reservesFor(observations, choice.pool.venue, choice.pool.tokens[1]);
        const unit = reserves ? perUnit(reserves, choice.pool.tokens[0] === asset) : null;
        pair[choice.option.id] = { asset: other, perUnit: unit };
        const otherHeld = heldInPocket(observations, choice.pocket, other);
        max[choice.option.id] = { amount: capByPair(held, otherHeld, unit), asset, where: choice.option.label };
      }
      if (held && !max[asset]) max[asset] = { amount: held, asset, where: POCKET_WHERE[choice.pocket] };
    }
  }
  if (missing.slots.includes("venue") || venueOptions.length === 1) {
    steps.push({ slot: "venue", prompt: "Where should it go?", options: venueOptions });
  }
  if (missing.slots.includes("amount")) {
    steps.push({
      slot: "amount",
      prompt: "How much?",
      options: [],
      max,
      presets: BALANCE_FRACTION_OPTIONS.map((option) => ({
        id: option.id,
        label: option.label,
        percent: String(Math.round(option.fraction * 100)),
      })),
      ...(Object.keys(pair).length ? { pair } : {}),
    });
  }
  if (!steps.length) return null;
  const id = createHash("sha256").update(JSON.stringify({ missing, steps: steps.map((step) => [step.slot, step.options.map((option) => option.id)]) })).digest("hex").slice(0, 16);
  return { id, title: titleFor(missing, ops), subtitle: "Choose which, where and how much", steps };
}

export function answerProblem(issued: Questionnaire | undefined, answers: QuestionnaireAnswers): string | null {
  if (!issued) return "No questionnaire was issued for this conversation.";
  if (answers.questionnaireId !== issued.id) return "That questionnaire is no longer the one that was asked.";
  if (!answers.summary.trim()) return "The answer needs a summary of what was chosen.";
  const assetStep = issued.steps.find((step) => step.slot === "asset");
  const venueStep = issued.steps.find((step) => step.slot === "venue");
  const assetIds = assetStep ? assetStep.options.map((option) => option.id) : [answers.asset];
  if (assetStep && !assetIds.includes(answers.asset)) return "That asset was not one of the options.";
  if (!assetStep && answers.asset !== assetIds[0] && !issued.steps.some((step) => step.options.some((option) => option.forAsset === answers.asset || option.id === answers.asset))) {
    return "That asset was not one of the options.";
  }
  if (venueStep) {
    const matches = venueStep.options.filter((option) => !option.forAsset || option.forAsset === answers.asset);
    const picked = answers.venue
      ? matches.find((option) => option.id === answers.venue)
      : matches.length === 1 ? matches[0] : undefined;
    if (!picked) return "That venue was not one of the options.";
  } else if (answers.venue !== null) {
    const known = issued.steps.flatMap((step) => step.options).some((option) => option.id === answers.venue);
    if (!known) return "That venue was not one of the options.";
  }
  const amountStep = issued.steps.find((step) => step.slot === "amount");
  const cap = amountStep?.max?.[answers.venue ?? ""] ?? amountStep?.max?.[answers.asset];
  // A linked "all of what you just …" answer needs an earlier section to link to; a
  // single-action questionnaire issues none, so it can only be forged.
  if (answers.amount.kind === "previous_leg") return "That amount was not one of the options.";
  if (answers.amount.kind === "fraction") {
    const percent = Number(answers.amount.percent);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return "The share has to be between 0 and 100.";
  } else {
    let amount: bigint;
    try { amount = decimalWad(answers.amount.amount); } catch { return "That amount is not a number."; }
    if (amount <= ZERO) return "The amount has to be more than zero.";
    if (cap) {
      try {
        if (amount > decimalWad(cap.amount)) return `That is more than the ${cap.amount} ${cap.asset} available.`;
      } catch { return "The issued maximum could not be read."; }
    }
  }
  return null;
}

export function actionFromAnswers(issued: Questionnaire, answers: QuestionnaireAnswers): StatedAction {
  const venueOptions = issued.steps.find((step) => step.slot === "venue")?.options.filter((option) => !option.forAsset || option.forAsset === answers.asset) ?? [];
  const venue = answers.venue
    ? venueOptions.find((option) => option.id === answers.venue) ?? issued.steps.flatMap((step) => step.options).find((option) => option.id === answers.venue)
    : venueOptions.length === 1 ? venueOptions[0] : undefined;
  const op = (venue?.op ?? issued.steps.flatMap((step) => step.options).find((option) => option.op)?.op) as WorkflowOp;
  const flow = OP_FLOW[op];
  const pool = venue?.id.startsWith("add_liquidity:") ? lpPairs().find((pair) => pair.venue === venue.id.slice("add_liquidity:".length) && pair.tokens.includes(answers.asset as AssetId)) : undefined;
  const other = pool ? (pool.tokens[0] === answers.asset ? pool.tokens[1] : pool.tokens[0]) : undefined;
  const sizing: PlanLeg["sizing"] = answers.amount.kind === "fraction"
    ? { kind: "fraction", percent: answers.amount.percent, of: flow.from === "wallet" ? "idle" : "position", sourceQuote: answers.summary }
    : answers.amount.kind === "literal"
      ? { kind: "literal", amount: answers.amount.amount, sourceQuote: answers.summary }
      // Refused by answerProblem before this is reached; kept total so the type stays honest.
      : { kind: "previous_leg" };
  return {
    op,
    asset: answers.asset,
    ...(other ? { assetOut: other } : {}),
    ...(pool ? { venue: pool.venue } : {}),
    sizing,
    sourceQuote: answers.summary,
  };
}
