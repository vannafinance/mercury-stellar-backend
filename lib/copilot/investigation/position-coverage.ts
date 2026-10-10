import { OP_FLOW } from "../workflow/types";
import { catalogEntry } from "./catalog";
import { PRICE_MAX_AGE_MS } from "./candidates";
import type { StrategyRead } from "./strategy-reads";
import type { GoalUnderstanding, Observation } from "./types";

/**
 * Broad or uncertain position answers cover every pocket. An explicitly scoped
 * factual answer may request only selected pockets, anchored to the user's text.
 *
 * 25 Sep, live: "show my positions" listed margin collateral, debt and Blend, and left out the
 * Earn lend made minutes earlier and every LP position. The model chooses reads one by one, and
 * the Earn and LP reads each need an asset, so it skipped them. Which reads are position reads is
 * OP_FLOW's `positionRead`; which assets each takes is that read's own catalog enum. Nothing here
 * names an asset or a pool. Narrowing uses model-declared capabilities and an exact
 * source quote; it never classifies prompt wording with patterns. Strategy/action
 * dependencies cannot be narrowed by this optional answer-only field.
 */
export function positionReadCapabilities(): string[] {
  return [...new Set(Object.values(OP_FLOW).map((flow) => flow.positionRead).filter((read): read is NonNullable<typeof read> => !!read))];
}

export function missingPositionReads(observations: readonly Observation[], goal?: GoalUnderstanding, messages: readonly string[] = [], forceAll = false): StrategyRead[] {
  const positionReads = positionReadCapabilities();
  if (!forceAll && !observations.some((item) => positionReads.includes(item.capability as never))) return [];
  const seen = (capability: string, asset?: string) => observations.some((item) =>
    item.status === "ok" && item.capability === capability && (asset === undefined || item.args.asset === asset)
    && (!forceAll || (!!item.data && Date.now() - item.observedAt <= PRICE_MAX_AGE_MS)));
  const scope = goal?.positionReadScope;
  const selected = !forceAll && goal?.intent === "answer" && !goal.actions?.length && !goal.write
    && scope?.kind === "selected" && scope.capabilities.length > 0
    && scope.capabilities.every((capability) => positionReads.includes(capability))
    && scope.sourceQuote.trim().length > 0 && messages.some((message) => message.includes(scope.sourceQuote));
  const required = selected ? positionReads.filter((capability) => scope.capabilities.includes(capability)) : positionReads;
  const wanted: StrategyRead[] = [];
  for (const capability of required) {
    const spec = catalogEntry(capability)?.modelArgs.asset;
    if (spec && spec.type === "enum") {
      for (const asset of spec.values) if (!seen(capability, asset)) wanted.push({ capability, args: { asset } });
    } else if (!seen(capability)) {
      wanted.push({ capability, args: {} });
    }
  }
  return wanted;
}
