import { OP_FLOW } from "../workflow/types";
import { catalogEntry } from "./catalog";
import type { StrategyRead } from "./strategy-reads";
import type { Observation } from "./types";

/**
 * An answer about positions reads every position pocket, not only the ones the model picked.
 *
 * 25 Sep, live: "show my positions" listed margin collateral, debt and Blend, and left out the
 * Earn lend made minutes earlier and every LP position. The model chooses reads one by one, and
 * the Earn and LP reads each need an asset, so it skipped them. Which reads are position reads is
 * OP_FLOW's `positionRead`; which assets each takes is that read's own catalog enum. Nothing here
 * names a capability, an asset or a pool, and nothing reads the user's words: it runs only when
 * the model itself already read some position pocket.
 */
export function missingPositionReads(observations: readonly Observation[]): StrategyRead[] {
  const positionReads = [...new Set(Object.values(OP_FLOW).map((flow) => flow.positionRead).filter((read): read is NonNullable<typeof read> => !!read))];
  if (!observations.some((item) => positionReads.includes(item.capability as never))) return [];
  const seen = (capability: string, asset?: string) => observations.some((item) =>
    item.capability === capability && (asset === undefined || item.args.asset === asset));
  const wanted: StrategyRead[] = [];
  for (const capability of positionReads) {
    const spec = catalogEntry(capability)?.modelArgs.asset;
    if (spec && spec.type === "enum") {
      for (const asset of spec.values) if (!seen(capability, asset)) wanted.push({ capability, args: { asset } });
    } else if (!seen(capability)) {
      wanted.push({ capability, args: {} });
    }
  }
  return wanted;
}
