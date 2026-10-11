import { ASSET_IDS, resolveAssetDef } from "../registry/assets";
import { OP_FLOW, type ProposalStep } from "../workflow/types";
import { pct, shownApyPct, type RateKind } from "./apy";
import type { RateComparison } from "./rate-comparison";
import type { ResearchFact } from "./view";

/**
 * What else was checked for the same job.
 *
 * A strategy that lends BLUSDC to Earn did not only look at BLUSDC: the wallet also holds AQUSDC and SOUSDC, which the
 * oracle prices as the same dollar. The user asked for "usdc", not for one of the three, so the answer says the others
 * were compared and what they pay, from the rates that were read (7 Oct: "kyu sirf BLUSDC, baaki check hue ya nahi").
 *
 * "The same job" and "the same token family" come from the registry, not from a list of names: a token with the same
 * oracle feed, an Earn pool, and a spendable balance in the wallet, compared on the rate of the venue the plan uses.
 */
export interface ConsideredToken {
  asset: string;
  label: string;
  venue: "Earn" | "Blend";
  /** The rate as that venue's page shows it, two decimals, no unit. */
  apy: string;
  /** The same figure for the token the plan actually uses. */
  leadApy: string;
  leadAsset: string;
  leadLabel: string;
}

/** What the wallet holds that can be spent, by token, from the wallet read's own rows. */
export function walletSpendable(facts: readonly ResearchFact[]): Map<string, number> {
  const held = new Map<string, { balance?: number; spendable?: number }>();
  for (const fact of facts) {
    if (fact.venue !== "wallet") continue;
    const kind = fact.label.endsWith(" wallet spendable") ? "spendable" : fact.label.endsWith(" wallet balance") ? "balance" : null;
    if (!kind) continue;
    const symbol = fact.label.slice(0, fact.label.indexOf(" wallet "));
    const value = Number(fact.value);
    if (Number.isFinite(value)) held.set(symbol, { ...held.get(symbol), [kind]: value });
  }
  return new Map([...held].map(([symbol, entry]) => [symbol, entry.spendable ?? entry.balance ?? 0]));
}

const KIND_VENUE: Partial<Record<RateKind, "Earn" | "Blend">> = { earn_supply: "Earn", blend_supply: "Blend" };

export function consideredAlongside(
  steps: readonly Pick<ProposalStep, "op" | "asset">[],
  comparisons: readonly RateComparison[],
  facts: readonly ResearchFact[],
): ConsideredToken[] {
  const spendable = walletSpendable(facts);
  const rateOf = (asset: string, kind: RateKind): string | null => {
    const row = comparisons.find((comparison) => comparison.asset === asset);
    const apr = kind === "earn_supply" ? row?.earnSupplyApr : kind === "blend_supply" ? row?.blendSupplyApr : null;
    return apr != null && Number.isFinite(Number(apr)) ? pct(shownApyPct(kind, apr)) : null;
  };
  const out: ConsideredToken[] = [];
  const seen = new Set<string>();
  // A token the plan itself uses on that rate is not an alternative to it (7 Oct: "BLUSDC 19.25% against 19.25% for BLUSDC").
  const used = new Set(steps.map((step) => `${step.asset}:${OP_FLOW[step.op].rate}`));
  for (const step of steps) {
    const kind = OP_FLOW[step.op].rate as RateKind | null;
    const venue = kind ? KIND_VENUE[kind] : undefined;
    if (!kind || !venue) continue;
    const lead = resolveAssetDef(step.asset);
    const leadApy = rateOf(step.asset, kind);
    if (!lead || leadApy === null) continue;
    for (const id of ASSET_IDS) {
      const other = resolveAssetDef(id);
      if (!other || id === step.asset || other.oracleSymbol !== lead.oracleSymbol || !other.earnSymbol) continue;
      if ((spendable.get(id) ?? 0) <= 0 || seen.has(`${id}:${kind}`) || used.has(`${id}:${kind}`)) continue;
      const apy = rateOf(id, kind);
      if (apy === null) continue;
      seen.add(`${id}:${kind}`);
      out.push({ asset: id, label: other.displayLabel, venue, apy, leadApy, leadAsset: step.asset, leadLabel: lead.displayLabel });
    }
  }
  return out;
}

/** One sentence, in figures that come from the reads. Empty when nothing else was comparable. */
export function consideredSentence(considered: readonly ConsideredToken[]): string {
  if (!considered.length) return "";
  const lead = considered[0];
  const parts = considered.map((token) => `${token.label} ${token.apy}%`).join(", ");
  const best = considered.every((token) => Number(token.leadApy) >= Number(token.apy));
  return ` I also compared your other ${lead.venue} options for the same dollar: ${parts} against ${lead.leadApy}% for ${lead.leadLabel}${best ? `, which pays the most of them` : ""}.`;
}
