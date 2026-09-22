/**
 * A sealed pool read must still be quotable on the next turn.
 *
 * `compactData` is an allowlist whose fallback is `{}`. Neither pool capability had a
 * branch, so a pool read that succeeded on one turn came back as an empty object on the
 * next — and `poolReservesFrom` cannot quote nothing.
 *
 * Live, 16 Sep: "the soroswap pool's live on-chain reserves were unavailable" for a pair
 * whose reserves had just been read successfully, and the same hole made every Aquarius
 * read warn "aquarius pool reserves: no supported display fields were available".
 */
import { describe, expect, it } from "vitest";
import { compactResearchEvidence } from "@/lib/copilot/investigation/evidence";
import { poolReservesFrom } from "@/lib/copilot/investigation/pool-quote";
import type { Observation } from "@/lib/copilot/investigation/types";

function poolRead(capability: string, paired: string): Observation {
  return {
    id: "o1",
    capability,
    args: { asset: paired },
    observedAt: 1_000,
    status: "ok",
    data: {
      found: true,
      venue: capability.startsWith("soroswap") ? "soroswap" : "aquarius",
      pool: {
        pool_address: "CPOOL",
        pool_type: "constant_product",
        fee: "0.0030",
        reserves: { XLM: "22033.5854513", [paired]: "1663.2424668" },
        reserves_raw: { XLM: "220335854513", [paired]: "16632424668" },
        total_share: "5891.826539",
        available: true,
        reserves_source: "soroban_reserves",
      },
      token_contracts: { XLM: "CXLM", [paired]: "CPAIRED" },
    },
  } as Observation;
}

describe.each([
  ["soroswap_pool_reserves", "SOUSDC"],
  ["aquarius_pool_reserves", "AQUSDC"],
])("%s survives sealing", (capability, paired) => {
  const sealed = compactResearchEvidence([poolRead(capability, paired)], null, 1_000);
  const carried = sealed.observations[0];

  it("is kept in the bundle at all", () => {
    expect(carried).toBeDefined();
    expect(carried.capability).toBe(capability);
  });

  it("still quotes after compaction — the whole point of carrying it", () => {
    const reserves = poolReservesFrom(carried.data);
    expect(reserves).not.toBeNull();
    expect(reserves!.xlm).toBe("22033.5854513");
    expect(reserves!.paired).toBe("1663.2424668");
    expect(reserves!.fee).toBe("0.0030");
    expect(reserves!.totalShare).toBe("5891.826539");
  });

  it("keeps the proof the numbers came from the ledger, not an indexer", () => {
    const pool = (carried.data as Record<string, any>).pool;
    expect(pool.reserves_source).toBe("soroban_reserves");
  });
});
