/**
 * 23 Sep, X12 "earn and farm": the joined plan was sized from the Aquarius LP position, but
 * sealing dropped that read (no priority, past the 16-read cap, and no compaction branch, so
 * it sealed as {}). Propose then refused the plan it had just offered, and the card never came.
 */
import { describe, expect, it } from "vitest";
import { compactResearchEvidence } from "@/lib/copilot/investigation/evidence";
import type { Observation } from "@/lib/copilot/investigation/types";

const NOW = 1_700_000_000_000;
const obs = (id: string, capability: string, data: Record<string, unknown>, args: Record<string, unknown> = {}): Observation =>
  ({ id, capability, args, observedAt: NOW, status: "ok", data });
// More than the 16-read cap, with the LP read last, as it arrived live.
const MANY: Observation[] = [
  ...Array.from({ length: 12 }, (_, i) => obs(`p${i}`, "asset_price", { price_usd: "1" }, { asset: `A${i}` })),
  obs("w", "wallet_balances", { assets: [] }),
  obs("d", "account_debt", { debt: [] }),
  obs("c", "account_collateral", { collateral: [] }),
  obs("h", "account_health", { health_factor: "2.3" }),
  ...["XLM", "BLUSDC", "AQUSDC", "SOUSDC"].map((asset, i) => obs(`e${i}`, "earn_position", { vtokens: "1", underlying: "1" }, { asset })),
  obs("lp", "farm_lp_position", { lp_shares_human: "77.9871076", venue: "aquarius", token_a: "XLM", token_b: "AQUSDC", resolved: true, pool_stats: { big: "x".repeat(500) } }, { asset: "AQUSDC" }),
];

describe("sealing keeps what the plans need", () => {
  it("keeps a required LP read past the size cap, with its share count", () => {
    const sealed = compactResearchEvidence(MANY, null, NOW, [{ capability: "farm_lp_position", args: { asset: "AQUSDC" } }]);
    const lp = sealed.observations.find((o) => o.capability === "farm_lp_position");
    expect(lp?.data).toEqual({ lp_shares_human: "77.9871076", venue: "aquarius", token_a: "XLM", token_b: "AQUSDC", resolved: true });
  });

  it("still trims unrequired reads at the cap, as before", () => {
    const sealed = compactResearchEvidence(MANY, null, NOW);
    expect(sealed.observations.length).toBe(16);
  });
});
