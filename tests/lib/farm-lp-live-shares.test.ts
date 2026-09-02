/**
 * Aquarius remove must size against Farm's LP page, not MCP's tracking token.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserLpBalance: vi.fn(),
  getLpBalance: vi.fn(),
}));

vi.mock("@/lib/aquarius-utils", () => ({
  AQUARIUS_POOLS: [{ id: "aquarius-xlm-usdc", poolAddress: "CPOOL", tokens: ["XLM", "USDC"] }],
  AquariusService: { getUserLpBalance: mocks.getUserLpBalance },
}));
vi.mock("@/lib/stellar-utils", () => ({
  CONTRACT_ADDRESSES: { AQUARIUS_XLM_USDC_POOL: "CPOOL" },
}));
vi.mock("@/lib/soroswap-utils", () => ({
  SoroswapService: { getLpBalance: mocks.getLpBalance },
}));

import { readFarmAmmLpShares } from "@/lib/copilot/farm-lp";

describe("readFarmAmmLpShares — same number as Farm LP page", () => {
  it("reads Aquarius via getUserLpBalance (pool shares), not a tracking-token zero", async () => {
    mocks.getUserLpBalance.mockResolvedValue("12.64");
    const r = await readFarmAmmLpShares({ smartAccount: "CACCT", tokenB: "AQUSDC" });
    expect(r.venue).toBe("aquarius");
    expect(r.shares).toBe(12.64);
    expect(mocks.getUserLpBalance).toHaveBeenCalled();
  });

  it("reads Soroswap LP the same way Farm's Soroswap pool does", async () => {
    mocks.getLpBalance.mockResolvedValue("8.5");
    const r = await readFarmAmmLpShares({ smartAccount: "CACCT", tokenB: "SOUSDC" });
    expect(r.venue).toBe("soroswap");
    expect(r.shares).toBe(8.5);
  });
});
