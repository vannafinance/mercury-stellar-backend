import { assetsNamedIn, mentionsBareUsdc, venuesOf, type AssetDef } from "../registry/assets";
import { OP_FLOW, ASSET_OUT_OPS, type WorkflowOp } from "../workflow/types";

/**
 * The asset the user attached to an operation, in the words the model quoted for it.
 *
 * 8 Oct, live, from the owner's catalogue: "supply 10 AQUSDC to blend" came back as a plan to supply
 * BLUSDC, with "Read as: Supply 10 USDC (BLUSDC) to Blend". Blend has no AQUSDC reserve, which the sizer
 * would have refused for a leg that said AQUSDC, but the model had already swapped the asset, so the
 * refusal never fired and the user was offered a different token than the one they named.
 *
 * Only a quote that names exactly one asset counts, and a bare "USDC" never does (that is a question).
 */
export interface NamedOpAsset { op: WorkflowOp; asset: AssetDef }

export function namedOpAssets(
  namedOps: ReadonlyArray<{ op: WorkflowOp; sourceQuote: string }> | undefined,
  messages: readonly string[],
): NamedOpAsset[] {
  const out: NamedOpAsset[] = [];
  for (const row of namedOps ?? []) {
    if (!messages.some((message) => message.includes(row.sourceQuote)) || mentionsBareUsdc(row.sourceQuote)) continue;
    const named = assetsNamedIn(row.sourceQuote);
    if (named.length === 1) out.push({ op: row.op, asset: named[0] });
  }
  // One op named for two different assets is a list, not a pairing to hold a plan to.
  return out.filter((row) => out.every((other) => other.op !== row.op || other.asset.id === row.asset.id));
}

/**
 * Why the venue an op acts on does not take this asset, from the registry's own venue data; null when it does
 * (or when the op's venue is not a single-asset venue this can speak for).
 */
export function venueRefusal(op: WorkflowOp, asset: AssetDef): string | null {
  if ((ASSET_OUT_OPS as readonly string[]).includes(op) || op === "remove_liquidity") return null;
  const venue = OP_FLOW[op].venue;
  if (venuesOf(asset).includes(venue)) return null;
  return venue === "blend" ? `Blend has no ${asset.displayLabel} reserve`
    : venue === "earn" ? `${asset.displayLabel} has no Earn pool`
    : venue === "margin" ? `${asset.displayLabel} is not accepted by the margin account`
    : null;
}
