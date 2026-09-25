/**
 * A direct action with missing inputs becomes a questionnaire. Options come from
 * the op-flow table and the registry, never from a written list of venues or pools.
 */
import { createHash } from "node:crypto";
import { BALANCE_FRACTION_OPTIONS } from "../amount-intent";
import { resolveName } from "../intent/resolve-name";
import { allAssets, lpPairs, lpVenues, mentionsBareUsdc, resolveAssetDef, USDC_VARIANTS, type AssetId } from "../registry/assets";
import { normalizeVenue } from "../registry/intent";
import { deploysIntoPosition, feeds, holdsTokens, OP_FLOW, POSITION_POCKETS, producedAsset, touchesMarginAccount, WORKFLOW_OPS, type Pocket, type WorkflowOp } from "../workflow/types";
import { pastOf, pocketAfterMoves, venueLabel, verbOf } from "./plan";
import { decimalWad, formatWad, mulDown, WAD, ZERO } from "./fixed";
import { poolReservesFrom } from "./pool-quote";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
import type { Observation, PlanLeg, StatedAction } from "./types";
import type { Questionnaire, QuestionnaireAnswers, QuestionnaireOption, QuestionnaireSection, QuestionnaireStep } from "./view";
import type { StrategyRead } from "./strategy-reads";

export interface QuestionnaireMissing {
  op?: WorkflowOp;
  /** A registry id, or a bare family the user said ("USDC"). */
  asset?: string;
  slots: Array<"asset" | "venue" | "amount">;
  /** Exact substring of the user's message for this action. Anchored before the section is built. */
  sourceQuote?: string;
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
  const sourceQuote = typeof value.sourceQuote === "string" && value.sourceQuote.trim() ? value.sourceQuote : undefined;
  return { ...(op ? { op } : {}), ...(asset ? { asset } : {}), slots, ...(sourceQuote ? { sourceQuote } : {}) };
}

/** One object is a one-entry list. A list is one entry per action, in the user's order. */
export function parseQuestionnaireMissingList(value: unknown): QuestionnaireMissing[] | null {
  if (Array.isArray(value)) {
    if (!value.length) return null;
    const items = value.map((item) => parseQuestionnaireMissing(item));
    return items.every((item): item is QuestionnaireMissing => !!item) ? items : null;
  }
  const one = parseQuestionnaireMissing(value);
  return one ? [one] : null;
}

function namedAsset(asset: string | undefined): AssetId | null {
  if (!asset || asset.toUpperCase() === "USDC" || mentionsBareUsdc(asset)) return null;
  return resolveAssetDef(asset)?.id ?? null;
}

function familyNarrows(asset: string | undefined): boolean {
  return !!asset && (asset.toUpperCase() === "USDC" || mentionsBareUsdc(asset)) && !namedAsset(asset);
}

function messageWords(message: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const ch of message) {
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) current += ch;
    else if (current) { words.push(current); current = ""; }
  }
  if (current) words.push(current);
  return words;
}

/**
 * A word names a source pocket when it is `from` on a deploy op and not `to` on one
 * ("account"). It names a destination when it is `to` ("blend", "earn") or an LP venue.
 * "margin" is the venue field of the account pocket, so it is not a destination once
 * that pocket was named.
 */
function namedPlaces(messages: readonly string[]): { sources: Set<Pocket>; destinations: Set<string> } {
  const deploy = WORKFLOW_OPS.filter((op) => deploysIntoPosition(op));
  const froms = new Set(deploy.map((op) => OP_FLOW[op].from));
  const tos = new Set(deploy.map((op) => OP_FLOW[op].to));
  const pools = new Set<string>(lpVenues());
  const validDestinations = new Set<string>([...tos, ...pools]);
  const accountVenues = new Set<string>(
    WORKFLOW_OPS
      .filter((op) => touchesMarginAccount(op) && !POSITION_POCKETS.includes(OP_FLOW[op].from) && !POSITION_POCKETS.includes(OP_FLOW[op].to))
      .map((op) => OP_FLOW[op].venue)
  );
  const sources = new Set<Pocket>();
  const destinations = new Set<string>();
  for (const message of messages) {
    for (const word of messageWords(message)) {
      const lower = word.toLowerCase();
      if (froms.has(lower as Pocket) && !tos.has(lower as Pocket)) sources.add(lower as Pocket);
      else if (tos.has(lower as Pocket)) destinations.add(lower);
      const venue = normalizeVenue(word);
      if ((venue && accountVenues.has(venue)) || accountVenues.has(lower)) {
        sources.add("account");
      } else if (venue && validDestinations.has(venue)) {
        destinations.add(venue);
      }
      const hit = resolveName(word, ["venue"]);
      if ((hit.kind === "exact" || hit.kind === "near") && hit.candidates[0] && validDestinations.has(hit.candidates[0].id)) {
        destinations.add(hit.candidates[0].id);
      }
    }
  }
  if (sources.has("account")) {
    for (const v of accountVenues) destinations.delete(v);
  }
  return { sources, destinations };
}

function venuesNamed(messages: readonly string[]): Set<string> {
  return namedPlaces(messages).destinations;
}

function opServesVenue(op: WorkflowOp, venues: Set<string>): boolean {
  const flow = OP_FLOW[op];
  if (venues.has(flow.to) || venues.has(flow.venue)) return true;
  return op === "add_liquidity" && lpPairs().some((pair) => venues.has(pair.venue));
}

/**
 * The ops this question is choosing among.
 *
 * A guessed op is not a venue. When the question still asks where the tokens go, a
 * deploy op the model filled in is ignored unless the user's own words name a venue.
 */
export function opsInPlay(missing: QuestionnaireMissing, messages: readonly string[] = []): WorkflowOp[] {
  const deploy = WORKFLOW_OPS.filter((op) => deploysIntoPosition(op));
  const { sources, destinations } = namedPlaces(messages);
  if (missing.slots.includes("venue") && (sources.size > 0 || destinations.size > 0)) {
    const matched = deploy.filter((op) => {
      const flow = OP_FLOW[op];
      if (sources.size > 0 && ![...sources].some((pocket) => flow.from === pocket)) return false;
      if (destinations.size > 0 && !opServesVenue(op, destinations) && !destinations.has(flow.to)) return false;
      return true;
    });
    if (matched.length) return matched;
  }
  if (missing.slots.includes("venue") && missing.op && deploysIntoPosition(missing.op) && sources.size === 0 && destinations.size === 0) return deploy;
  if (missing.op) return [missing.op];
  return deploy;
}

function choiceId(op: WorkflowOp, asset: AssetId, venue?: string): string {
  return venue ? `${op}:${venue}:${asset}` : `${op}:${asset}`;
}

function pocketPhrase(pocket: Pocket): string {
  if (pocket === "wallet") return "in your wallet";
  if (pocket === "account") return "in your margin account";
  return `in ${POCKET_WHERE[pocket]}`;
}

function assetsAccepted(op: WorkflowOp): AssetId[] {
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

export function readsForQuestionnaire(missing: QuestionnaireMissing, observations: readonly Observation[], now: number, messages: readonly string[] = []): StrategyRead[] {
  const fresh = (capability: string, asset?: string) => observations.some((item) =>
    item.capability === capability && item.status === "ok" && item.data && now - item.observedAt <= 60_000 &&
    (asset === undefined || item.args.asset === asset));
  const wanted = new Map<string, StrategyRead>();
  const want = (capability: string, asset?: string) => {
    if (fresh(capability, asset)) return;
    wanted.set(`${capability}:${asset ?? ""}`, { capability, args: asset ? { asset } : {} });
  };
  const ops = opsInPlay(missing, messages);
  const assets = candidateAssets(missing, ops);
  for (const op of ops) {
    const flow = OP_FLOW[op];
    if (flow.from === "wallet" || flow.to === "wallet" || (flow.from === "account" && deploysIntoPosition(op))) want("wallet_balances");
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

function pocketRead(observations: readonly Observation[], pocket: Pocket): boolean {
  const capability = pocket === "wallet" ? "wallet_balances"
    : pocket === "account" ? "account_collateral"
      : pocket === "debt" ? "account_debt"
        : pocket === "earn" ? "earn_position"
          : pocket === "blend" ? "blend_position"
            : "farm_lp_position";
  return observations.some((item) => item.capability === capability && item.status === "ok" && item.data);
}

/** A read that does not list the asset holds none of it. An absent read is unknown. */
function amountInPocket(observations: readonly Observation[], pocket: Pocket, asset: AssetId): string | null {
  const held = heldInPocket(observations, pocket, asset);
  if (held) return held;
  return pocketRead(observations, pocket) ? "0" : null;
}

function wadOf(value: string | null): bigint {
  if (!value) return ZERO;
  try { return decimalWad(value); } catch { return ZERO; }
}

function sumKnown(parts: Array<string | null>): string | null {
  const known = parts.filter((part): part is string => part !== null);
  if (!known.length) return null;
  return formatWad(known.reduce((sum, part) => sum + wadOf(part), ZERO));
}

function balanceDetail(amount: string, asset: string, pocket: Pocket, rate?: string | null): string {
  const line = `${amount} ${asset} ${pocketPhrase(pocket)}`;
  return rate ? `${line} · ${rate}` : line;
}

function depositSentence(accountHeld: string, asset: string, shortfall: string): string {
  return `Your margin account has ${accountHeld} ${asset}; I'll deposit the other ${shortfall} from your wallet first.`;
}

function venueChoices(asset: AssetId, ops: readonly WorkflowOp[], observations: readonly Observation[], named: Set<string>): VenueChoice[] {
  const choices: VenueChoice[] = [];
  for (const op of ops) {
    const flow = OP_FLOW[op];
    if (!assetsAccepted(op).includes(asset)) continue;
    const accountHeld = flow.from === "account" ? amountInPocket(observations, "account", asset) : null;
    const walletTopUp = flow.from === "account" ? amountInPocket(observations, "wallet", asset) : null;
    const held = flow.from === "account"
      ? (accountHeld && accountHeld !== "0" ? accountHeld : walletTopUp && walletTopUp !== "0" ? accountHeld ?? "0" : null)
      : heldInPocket(observations, flow.from, asset);
    if (!held) continue;
    if (deploysIntoPosition(op) && flow.to === "earn" && resolveAssetDef(asset)?.earnSymbol) {
      const rate = earnRate(observations, asset);
      choices.push({
        pocket: flow.from,
        option: { id: choiceId(op, asset), label: "Earn", forAsset: asset, op, detail: balanceDetail(held, asset, flow.from, rate) },
      });
    } else if (deploysIntoPosition(op) && flow.to === "blend" && resolveAssetDef(asset)?.blendReserve) {
      const rate = blendRate(observations, asset);
      choices.push({
        pocket: flow.from,
        option: { id: choiceId(op, asset), label: "Farm · Blend", forAsset: asset, op, detail: balanceDetail(held, asset, flow.from, rate) },
      });
    } else if (deploysIntoPosition(op) && flow.to === "lp") {
      for (const pair of lpPairs()) {
        if (!pair.tokens.includes(asset)) continue;
        const pools = new Set<string>(lpVenues());
        const namedPools = [...named].filter((venue) => pools.has(venue));
        if (namedPools.length > 0 && !namedPools.includes(pair.venue)) continue;
        const other = pair.tokens[0] === asset ? pair.tokens[1] : pair.tokens[0];
        const otherHeld = amountInPocket(observations, flow.from, other);
        const label = `${venueLabel(pair.venue)} ${pair.tokens.join("/")} pool`;
        choices.push({
          pocket: flow.from,
          pool: pair,
          option: {
            id: choiceId(op, asset, pair.venue),
            label,
            forAsset: asset,
            op,
            detail: `pairs with ${other}${otherHeld && otherHeld !== "0" ? ` · ${otherHeld} ${other} ${pocketPhrase(flow.from)}` : ""}`,
          },
        });
      }
    } else if (!deploysIntoPosition(op)) {
      choices.push({
        pocket: flow.from,
        option: { id: choiceId(op, asset), label: verbOf(op), forAsset: asset, op, detail: balanceDetail(held, asset, flow.from) },
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

export function buildQuestionnaire(
  missing: QuestionnaireMissing,
  observations: readonly Observation[],
  now: number,
  messages: readonly string[] = [],
  baseObservations?: readonly Observation[],
): Questionnaire | null {
  void now;
  if (!missing.slots.length) return null;
  const named = venuesNamed(messages);
  const ops = opsInPlay(missing, messages);
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
        options.push({ id: asset, label: asset, detail: `${held.amount} ${asset} ${pocketPhrase(held.pocket)}` });
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
  const pair: Record<string, { asset: string; perUnit: string | null; note?: string }> = {};
  const max: NonNullable<QuestionnaireStep["max"]> = {};
  for (const asset of venueAssets) {
    for (const choice of venueChoices(asset, ops, observations, named)) {
      const spendsAccount = choice.pocket === "account";
      const accountHeld = spendsAccount ? amountInPocket(observations, "account", asset) : null;
      const walletHeld = amountInPocket(observations, "wallet", asset);
      const own = spendsAccount ? sumKnown([accountHeld, walletHeld]) : heldInPocket(observations, choice.pocket, asset);
      if (!own || own === "0") continue;
      venueOptions.push(choice.option);
      const where = spendsAccount && walletHeld && walletHeld !== "0"
        ? "your margin account and your wallet"
        : pocketPhrase(choice.pocket).replace(/^in /, "");
      const startingObs = baseObservations ?? observations;
      const starting = (spendsAccount ? (amountInPocket(startingObs, "account", asset) ?? "0") : heldInPocket(startingObs, choice.pocket, asset)) ?? own;
      max[choice.option.id] = { amount: own, asset, where, starting };
      const notes: string[] = [];
      const noteFor = (held: string | null, token: string, needed: bigint) => {
        if (!held || needed <= wadOf(held)) return;
        notes.push(depositSentence(held, token, formatWad(needed - wadOf(held))));
      };
      noteFor(accountHeld, asset, wadOf(own));
      if (choice.pool) {
        const other = choice.pool.tokens[0] === asset ? choice.pool.tokens[1] : choice.pool.tokens[0];
        const reserves = reservesFor(observations, choice.pool.venue, choice.pool.tokens[1]);
        const unit = reserves ? perUnit(reserves, choice.pool.tokens[0] === asset) : null;
        const otherAccount = amountInPocket(observations, "account", other);
        const otherWallet = amountInPocket(observations, "wallet", other);
        const otherFunds = sumKnown([otherAccount, otherWallet]);
        const capped = capByPair(own, otherFunds, unit);
        max[choice.option.id] = { amount: capped, asset, where, starting };
        notes.length = 0;
        noteFor(accountHeld, asset, wadOf(capped));
        if (unit && otherAccount) noteFor(otherAccount, other, (wadOf(capped) * wadOf(unit)) / WAD);
        const note = notes.length ? notes.join(" ") : undefined;
        pair[choice.option.id] = { asset: other, perUnit: unit, ...(note ? { note } : {}) };
        if (note) {
          choice.option.detail = `${choice.option.detail} ${note}`;
          max[choice.option.id].note = note;
        }
      } else if (notes.length) {
        const note = notes.join(" ");
        choice.option.detail = `${choice.option.detail} ${note}`;
        max[choice.option.id].note = note;
      }
      if (!max[asset]) max[asset] = { amount: own, asset, where, starting };
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

function checkAnswers(issued: Questionnaire | undefined, answers: QuestionnaireAnswers): string | null {
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
  if (answers.amount.kind === "previous_leg") {
    const link = amountStep?.options.find((option) => option.id.startsWith("previous:") && (!option.forAsset || option.forAsset === answers.asset));
    return link ? null : "That amount was not one of the options.";
  }
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
  const pool = venue?.id.startsWith("add_liquidity:") ? lpPairs().find((pair) => venue.id.split(":")[1] === pair.venue && pair.tokens.includes(answers.asset as AssetId)) : undefined;
  const other = pool ? (pool.tokens[0] === answers.asset ? pool.tokens[1] : pool.tokens[0]) : undefined;
  const sizing: PlanLeg["sizing"] = answers.amount.kind === "previous_leg"
    ? { kind: "previous_leg" }
    : answers.amount.kind === "fraction"
      ? { kind: "fraction", percent: answers.amount.percent, of: flow.from === "wallet" ? "idle" : "position", sourceQuote: answers.summary }
      : { kind: "literal", amount: answers.amount.amount, sourceQuote: answers.summary };
  return {
    op,
    asset: answers.asset,
    ...(other ? { assetOut: other } : {}),
    ...(pool ? { venue: pool.venue } : {}),
    sizing,
    sourceQuote: answers.summary,
  };
}

function quoteAt(quote: string | undefined, messages: readonly string[]): number {
  if (!quote) return Number.MAX_SAFE_INTEGER;
  for (const message of messages) {
    const at = message.indexOf(quote);
    if (at >= 0) return at;
  }
  return Number.MAX_SAFE_INTEGER;
}

function anchoredEntries(entries: readonly QuestionnaireMissing[], messages: readonly string[]): QuestionnaireMissing[] {
  return entries.filter((entry) => !entry.sourceQuote || messages.some((message) => message.includes(entry.sourceQuote!)));
}

function writeBalance(observations: readonly Observation[], pocket: Pocket, asset: string, amount: string): Observation[] {
  const next = observations.map((observation) => ({
    ...observation,
    data: observation.data ? structuredClone(observation.data) : observation.data,
  }));
  const target = next.find((observation) => observation.status === "ok" && observation.data && (
    pocket === "wallet" ? observation.capability === "wallet_balances" : observation.capability === "account_collateral"));
  if (!target?.data) return next;
  const spelled = pocket === "account" ? resolveAssetDef(asset)?.marginSymbol ?? asset : asset;
  if (pocket === "wallet") {
    const assets = Array.isArray(target.data.assets) ? target.data.assets : [];
    const row = assets.find((item) => isRecord(item) && item.symbol === asset);
    if (isRecord(row)) row.balance = amount;
    else assets.push({ symbol: asset, balance: amount, decimals: 7, status: "ok" });
    target.data.assets = assets;
  } else {
    const rows = Array.isArray(target.data.collateral) ? target.data.collateral : [];
    const row = rows.find((item) => isRecord(item) && (item.symbol === spelled || item.symbol === asset || item.asset === asset));
    if (isRecord(row)) row.balance = amount;
    else rows.push({ symbol: spelled, balance: amount });
    target.data.collateral = rows;
  }
  return next;
}

function projectMoves(
  observations: readonly Observation[],
  moves: ReadonlyArray<{ op: WorkflowOp; asset: string; assetOut?: string; amount: string }>,
): Observation[] {
  let next: Observation[] = [...observations];
  for (const move of moves) {
    const flow = OP_FLOW[move.op];
    for (const pocket of [flow.from, flow.to]) {
      if (!holdsTokens(pocket)) continue;
      const token = pocket === flow.to ? (producedAsset(move) ?? move.asset) : move.asset;
      const starting = amountInPocket(next, pocket, token as AssetId) ?? "0";
      const after = pocketAfterMoves(pocket, wadOf(starting), [move], token);
      next = writeBalance(next, pocket, token, formatWad(after < ZERO ? ZERO : after));
    }
  }
  return next;
}

interface BuiltSection {
  missing: QuestionnaireMissing;
  section: QuestionnaireSection;
}

/**
 * One questionnaire for every action that is still missing something, in the
 * user's order. A single object is one section and keeps today's steps.
 */
export function buildQuestionnaireSet(
  missing: QuestionnaireMissing | readonly QuestionnaireMissing[],
  observations: readonly Observation[],
  now: number,
  messages: readonly string[] = [],
  stated: readonly StatedAction[] = [],
  hasMarginAccount = true,
): Questionnaire | null {
  const rawEntries = anchoredEntries(Array.isArray(missing) ? [...missing] : [missing], messages);
  const entries = (hasMarginAccount ? rawEntries : rawEntries.filter((entry) => {
    if (entry.op && touchesMarginAccount(entry.op)) return false;
    const inPlay = opsInPlay(entry, messages);
    if (inPlay.length > 0 && inPlay.every((op) => touchesMarginAccount(op))) return false;
    return true;
  }))
    .sort((a, b) => quoteAt(a.sourceQuote, messages) - quoteAt(b.sourceQuote, messages));
  if (!entries.length) return null;
  let view = observations;
  const moves: Array<{ op: WorkflowOp; asset: string; assetOut?: string; amount: string; sectionId: string }> = [];
  const built: BuiltSection[] = [];
  for (const entry of entries) {
    const one = buildQuestionnaire(entry, view, now, entry.sourceQuote ? [entry.sourceQuote] : messages, observations);
    if (!one) continue;
    const links = moves.flatMap((move) => {
      if (!entry.op || !feeds(move.op, entry.op)) return [];
      const produced = producedAsset(move);
      if (!produced || !assetsAccepted(entry.op).includes(produced as AssetId)) return [];
      return [{
        id: `previous:${move.sectionId}:${produced}`,
        label: `All of the ${produced} you just ${pastOf(move.op)}`,
        forAsset: produced,
        detail: `${move.amount} ${produced}`,
        sourceSectionId: move.sectionId,
      }];
    });
    if (links.length) {
      const amount = one.steps.find((step) => step.slot === "amount");
      if (amount) amount.options = [...links, ...amount.options];
    }
    built.push({
      missing: entry,
      section: {
        id: one.id, title: one.title, actionIndex: built.length, position: quoteAt(entry.sourceQuote, messages),
        steps: one.steps, ...(entry.sourceQuote ? { sourceQuote: entry.sourceQuote } : {}),
        ...(entry.op ? { op: entry.op } : {}),
        ...(entry.op === "swap" && entry.sourceQuote && namedAsset(entry.asset)
          ? { assetOut: messageWords(entry.sourceQuote).map((word) => resolveAssetDef(word)?.id).find((id) => id && id !== namedAsset(entry.asset)) }
          : {}),
      },
    });
    const amountStep = one.steps.find((step) => step.slot === "amount");
    if (amountStep?.max && (moves.length || entries.length > 1)) {
      for (const cap of Object.values(amountStep.max)) cap.bound = "upper";
    }
    if (entry.op && entry.asset && namedAsset(entry.asset)) {
      const flow = OP_FLOW[entry.op];
      const ceiling = amountInPocket(view, flow.from, namedAsset(entry.asset)!);
      if (ceiling && ceiling !== "0" && holdsTokens(flow.to)) {
        moves.push({ op: entry.op, asset: namedAsset(entry.asset)!, amount: ceiling, sectionId: one.id });
        view = projectMoves(observations, moves);
      }
    }
  }
  if (!built.length) return null;
  const sections = built.map((item) => item.section);
  const steps = sections.length === 1 ? sections[0].steps : sections.flatMap((section) => section.steps);
  const id = createHash("sha256").update(JSON.stringify(sections.map((section) => [section.title, section.steps.map((step) => [step.slot, step.options.map((option) => option.id)])]))).digest("hex").slice(0, 16);
  const sealed = stated
    .filter((action) => !action.sourceQuote || messages.some((message) => message.includes(action.sourceQuote)))
    .map((action) => ({ position: quoteAt(action.sourceQuote, messages), action }));
  return {
    id,
    title: sections.length === 1 ? sections[0].title : "A few things to fill in",
    subtitle: sections.length === 1 ? "Choose which, where and how much" : "One section for each action",
    steps,
    sections,
    ...(sealed.length ? { stated: sealed } : {}),
  };
}

function opForSection(section: QuestionnaireSection, venueId: string | null): WorkflowOp | undefined {
  if (venueId) {
    const venueOption = section.steps.flatMap((step) => step.options).find((opt) => opt.id === venueId);
    if (venueOption?.op) return venueOption.op as WorkflowOp;
    const opPrefix = WORKFLOW_OPS.find((op) => venueId.startsWith(`${op}:`));
    if (opPrefix) return opPrefix;
  }
  if (section.op) return section.op as WorkflowOp;
  const fromOption = section.steps.flatMap((step) => step.options).find((opt) => opt.op)?.op;
  if (fromOption) return fromOption as WorkflowOp;
  return undefined;
}

export function answerProblem(issued: Questionnaire | undefined, answers: QuestionnaireAnswers): string | null {
  if (answers.sections?.length) {
    if (!issued) return "No questionnaire was issued for this conversation.";
    if (answers.questionnaireId !== issued.id) return "That questionnaire is no longer the one that was asked.";
    if (!answers.summary.trim()) return "The answer needs a summary of what was chosen.";
    const issuedIds = issued.sections?.map((section) => section.id) ?? [];
    const answeredIds = answers.sections.map((section) => section.sectionId);
    if (issuedIds.length !== answeredIds.length || new Set(answeredIds).size !== answeredIds.length || issuedIds.some((id) => !answeredIds.includes(id))) {
      return "Answer each section once.";
    }
    const running = new Map<string, bigint>();
    for (const sec of issued.sections ?? []) {
      const amtStep = sec.steps.find((s) => s.slot === "amount");
      if (amtStep?.max) {
        for (const [key, cap] of Object.entries(amtStep.max)) {
          if (!cap.starting) continue;
          const op = opForSection(sec, key);
          if (!op) continue;
          const flow = OP_FLOW[op];
          if (!holdsTokens(flow.from)) continue;
          const pocketKey = `${flow.from}:${cap.asset}`;
          if (!running.has(pocketKey)) {
            running.set(pocketKey, wadOf(cap.starting));
          }
        }
      }
    }
    const producedBySection = new Map<string, { asset: string; amount: bigint }>();
    for (const sectionAnswer of answers.sections) {
      const section = issued.sections?.find((item) => item.id === sectionAnswer.sectionId);
      if (!section) return "That section was not one of the ones asked.";
      const problem = checkAnswers({ ...issued, steps: section.steps, sections: undefined }, {
        ...answers, asset: sectionAnswer.asset, venue: sectionAnswer.venue, amount: sectionAnswer.amount, sections: undefined,
      });
      if (problem) return problem;
      const options = section.steps.flatMap((step) => step.options);
      const op = opForSection(section, sectionAnswer.venue);
      if (op) {
        const flow = OP_FLOW[op];
        const key = `${flow.from}:${sectionAnswer.asset}`;
        const cap = section.steps.find((step) => step.slot === "amount")?.max?.[sectionAnswer.venue ?? ""]
          ?? section.steps.find((step) => step.slot === "amount")?.max?.[sectionAnswer.asset];
        const start = cap?.starting ? wadOf(cap.starting) : cap ? wadOf(cap.amount) : null;
        if (start !== null && !running.has(key)) running.set(key, start);

        let amount: bigint;
        if (sectionAnswer.amount.kind === "literal") {
          try { amount = decimalWad(sectionAnswer.amount.amount); } catch { return "That amount is not a number."; }
        } else if (sectionAnswer.amount.kind === "fraction") {
          const avail = running.get(key) ?? ZERO;
          try {
            const frac = BigInt(Math.round(parseFloat(sectionAnswer.amount.percent) * 100));
            amount = (avail * frac) / BigInt(10000);
          } catch {
            return "That percentage is not valid.";
          }
        } else if (sectionAnswer.amount.kind === "previous_leg") {
          const linkedOpt = options.find((opt) => opt.id.startsWith("previous:") && (!opt.forAsset || opt.forAsset === sectionAnswer.asset));
          const srcId = linkedOpt?.sourceSectionId ?? linkedOpt?.id.split(":")[1];
          const prev = srcId ? producedBySection.get(srcId) : undefined;
          amount = prev?.amount ?? ZERO;
        } else {
          amount = ZERO;
        }

        if (running.has(key)) {
          const left = running.get(key)!;
          if (amount > left) return `That is more than the ${formatWad(left)} ${sectionAnswer.asset} available.`;
          running.set(key, left - amount);
        }
        if (holdsTokens(flow.to)) {
          const producedToken = producedAsset({ op, asset: sectionAnswer.asset }) ?? sectionAnswer.asset;
          const toKey = `${flow.to}:${producedToken}`;
          running.set(toKey, (running.get(toKey) ?? ZERO) + amount);
        }
        producedBySection.set(sectionAnswer.sectionId, { asset: sectionAnswer.asset, amount });
      }
    }
    return null;
  }
  return checkAnswers(issued, answers);
}

export function actionsFromAnswers(issued: Questionnaire, answers: QuestionnaireAnswers): StatedAction[] {
  if (!answers.sections?.length) return [actionFromAnswers(issued, answers)];
  const answered = answers.sections.map((sectionAnswer) => {
    const section = issued.sections?.find((item) => item.id === sectionAnswer.sectionId);
    const action = actionFromAnswers(
      { ...issued, steps: section?.steps ?? issued.steps },
      { ...answers, asset: sectionAnswer.asset, venue: sectionAnswer.venue, amount: sectionAnswer.amount, sections: undefined },
    );
    if (action.op === "swap" && section?.assetOut) return { position: section.position ?? 0, action: { ...action, assetOut: section.assetOut } };
    return { position: section?.position ?? 0, action };
  });
  return [...(issued.stated ?? []), ...answered].sort((a, b) => a.position - b.position).map((item) => item.action);
}
