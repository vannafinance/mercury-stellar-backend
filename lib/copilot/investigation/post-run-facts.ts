import type { MarginSnapshot } from "@/lib/account-snapshot";
import { healthObservations } from "./fast-path";
import { liquidationObservation } from "./liquidation";
import { normalizeResearchFacts } from "./normalize";
import type { ResearchFact } from "./view";

/**
 * The figures a user may ask for in the same breath as a run ("...then show my leverage", "...and tell me my
 * liquidation price"), read from the account as it stands after it, in the Margin page's own terms.
 *
 * They are offered to the reply, never required of it: a request that did not ask for them does not get them.
 * Nothing here is a new read - the position was already read for the health factor, and the liquidation answer is
 * computed from that same snapshot - and the health factor itself is not repeated, since the reply already has it.
 */
export function postRunFacts(
  position: { grossCollateralUsd: string; debtUsd: string; healthFactor: string | null; snapshot: MarginSnapshot },
  observedAt: number,
): ResearchFact[] {
  const [positionObservation] = healthObservations({
    grossCollateralUsd: position.grossCollateralUsd, debtUsd: position.debtUsd, healthFactor: position.healthFactor,
  });
  const { facts } = normalizeResearchFacts([
    { ...positionObservation, id: "post-run-position", observedAt },
    liquidationObservation(position.snapshot, observedAt),
  ]);
  const own = facts.flatMap((fact): ResearchFact[] => {
    if (fact.sourcePath === "net_leverage") return [{ ...fact, id: "account:leverage_now", label: "account leverage now" }];
    if (fact.group === "Liquidation") return [{ ...fact, id: `account:liquidation:${fact.id.replace(/^[^:]*:/, "")}` }];
    return [];
  });
  const account: ResearchFact = {
    id: "account:margin_account", label: "margin account", value: "already open", unit: "", venue: "margin",
    evidenceId: "post-settlement-account-read", sourcePath: "margin_account", readAt: observedAt,
  };
  return [...own, account].map((fact) => ({ ...fact, requiredInReply: false }));
}
