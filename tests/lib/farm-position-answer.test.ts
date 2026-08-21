/**
 * Reported live, issue #18: "My farm position" answered with a card explicitly badged
 * MARGIN ACCOUNT and a note admitting "Blend supplies and Aquarius LP shares stay on
 * Farm" — the whole-account fan-out's farm-overview call only ever contributes a
 * best-effort PROSE sentence, never structured facts, so a real Blend/Aquarius LP
 * position never actually showed up. This exercises the actual handler
 * (`farmPositionAnswer`, dispatched via `handleChat`), not just the router's
 * classification — the classification-only tests are in supply-position-read.test.ts.
 *
 * An earlier version of this fix reused `getLitePositionsFromChain` (nets farm supply
 * against margin debt in the same asset — right for "net exposure", wrong for "how much
 * do I have"); live-verified it answered "$0.00" for a real ~$49.86 Blend BLUSDC supply.
 * These tests pin the corrected version: gross balances straight from
 * `BlendService`/`AquariusService`/`SoroswapService`, no debt-netting.
 */
import { describe, expect, it, vi } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

describe("'my farm position' routes to the Farm-only read, not the margin fan-out", () => {
  it("routes without naming a specific venue", () => {
    const r = routeMessage("my farm position");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_farm_position");
  });

  it("narrows to just that venue when one is named, on the same route", () => {
    // No separate per-venue route exists — naming "blend"/"aquarius"/"soroswap" alongside
    // "farm position" used to fall through the exclusion built for this comment's old
    // (incorrect) assumption, straight to the generic capabilities blurb. It now narrows
    // the SAME farm-overview read instead.
    const r = routeMessage("my blend farm position");
    expect(r.kind).toBe("read");
    if (r.kind === "read") {
      expect(r.template_id).toBe("query_farm_position");
      expect(r.args).toMatchObject({ venue: "blend" });
    }
  });

  it("narrows to Soroswap or Aquarius by name, not just Blend", () => {
    for (const [ask, venue] of [
      ["Give my Soroswap Farm Position Details", "soroswap"],
      ["Give my Aquarius Farm Position Details", "aquarius"],
    ] as const) {
      const r = routeMessage(ask);
      expect(r.kind, ask).toBe("read");
      if (r.kind === "read") {
        expect(r.template_id, ask).toBe("query_farm_position");
        expect(r.args, ask).toMatchObject({ venue });
      }
    }
  });

  it("my Blend/XLM position stats is holdings, not pool-wide reserve APY", () => {
    const r = routeMessage("what is my xlm blend pool positions stats?");
    expect(r.kind).toBe("read");
    if (r.kind === "read") {
      expect(r.template_id).toBe("query_farm_position");
      expect(r.args).toMatchObject({ venue: "blend" });
    }
  });

  it("how is the blend pool doing stays pool stats", () => {
    const r = routeMessage("how is my blend pool doing");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_blend");
  });

  it("what is my blend pool stats is the two-column Blend read", () => {
    const r = routeMessage("what is my blend pool stats?");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_blend");
  });

  it("give me my farm stats is farm stats, not earn", () => {
    const r = routeMessage("give me my farm stats");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_farm_stats");
  });
});

const mocks = vi.hoisted(() => ({
  getUserBlendBalance: vi.fn(),
  getBlendReserveData: vi.fn(),
  getLpBalance: vi.fn(),
  getPoolStats: vi.fn(),
  getUserLpBalance: vi.fn(),
  getAquariusPoolStats: vi.fn(),
}));
vi.mock("@/lib/blend-utils", () => ({
  BlendService: {
    getUserBlendBalance: mocks.getUserBlendBalance,
    getBlendReserveData: mocks.getBlendReserveData,
  },
}));
vi.mock("@/lib/soroswap-utils", () => ({
  SoroswapService: { getLpBalance: mocks.getLpBalance, getPoolStats: mocks.getPoolStats },
}));
vi.mock("@/lib/aquarius-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aquarius-utils")>();
  return {
    ...actual,
    AquariusService: {
      ...actual.AquariusService,
      getUserLpBalance: mocks.getUserLpBalance,
      getAquariusPoolStats: mocks.getAquariusPoolStats,
    },
  };
});
vi.mock("@/lib/oracle-price", () => ({
  fetchTokenPrices: vi.fn().mockResolvedValue({ XLM: 0.13, USDC: 1 }),
  getCachedTokenPrice: (token: string) => (token === "XLM" ? 0.13 : 1),
}));

import { handleChat } from "@/lib/copilot/handle";

const base = {
  user_id: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  tier: "free" as const,
  surface: "copilot" as const,
};

const noBlend = { bTokenBalance: "0", underlyingBalance: "0" };

describe("the farm-position answer never mentions the margin account", () => {
  it("reports the real GROSS Blend/Aquarius balance, not a debt-netted equity figure", async () => {
    // Blend XLM: none. Blend USDC (BLUSDC): a real ~$49.86 supply, gross — the exact
    // figure that a debt-netted computation zeroed out in the reported bug.
    mocks.getUserBlendBalance.mockImplementation(async (_addr: string, symbol: string) =>
      symbol === "USDC" ? { bTokenBalance: "47.22", underlyingBalance: "49.8607014" } : noBlend,
    );
    mocks.getBlendReserveData.mockImplementation(async (symbol: string) =>
      symbol === "USDC" ? { supplyAPY: "0.07" } : { supplyAPY: "0.00" },
    );
    mocks.getLpBalance.mockResolvedValue("0");
    mocks.getPoolStats.mockResolvedValue(null);
    mocks.getUserLpBalance.mockResolvedValue("0");
    mocks.getAquariusPoolStats.mockResolvedValue(null);

    const res = await handleChat({ ...base, message: "my farm position" });
    expect(res.kind).toBe("answer");
    expect(res.answer?.venue).not.toBe("margin");
    expect(res.message).not.toMatch(/margin account/i);
    const facts = res.answer?.facts ?? [];
    const blendUsdc = facts.find((f) => f.label === "Blend · BLUSDC");
    expect(blendUsdc?.value).toMatch(/49\.86/);
    expect(blendUsdc?.value).not.toMatch(/\$0\.00/);
    expect(res.answer?.table?.rows.some((r) => r.includes("0.07%"))).toBe(true);
  });

  it("reports the actual LP share count, not just the underlying token split", async () => {
    // Reported live: "Soroswap · XLM/USDC LP: 28.904 XLM + 1.9678 USDC ($6.38)" — the
    // underlying split, correct as far as it went, but never the LP share amount itself.
    mocks.getUserBlendBalance.mockResolvedValue(noBlend);
    mocks.getLpBalance.mockResolvedValue("5.5"); // Soroswap LP shares held
    mocks.getPoolStats.mockResolvedValue({ totalShares: "100", reserveXLM: "1000", reserveUSDC: "20" });
    mocks.getUserLpBalance.mockResolvedValue("0");
    mocks.getAquariusPoolStats.mockResolvedValue(null);

    const res = await handleChat({ ...base, message: "my farm position" });
    expect(res.kind).toBe("answer");
    const facts = res.answer?.facts ?? [];
    const ssLp = facts.find((f) => f.label === "Soroswap · XLM/USDC LP");
    expect(ssLp?.value).toMatch(/5\.5\s*LP/i);
  });

  it("says plainly when there are no open farm positions", async () => {
    mocks.getUserBlendBalance.mockResolvedValue(noBlend);
    mocks.getLpBalance.mockResolvedValue("0");
    mocks.getPoolStats.mockResolvedValue(null);
    mocks.getUserLpBalance.mockResolvedValue("0");
    mocks.getAquariusPoolStats.mockResolvedValue(null);

    const res = await handleChat({ ...base, message: "my farm position" });
    expect(res.kind).toBe("answer");
    expect(res.message).toMatch(/Deposit TVL is \$0\.00/i);
  });

  it("includes Aquarius LP shares even when pool stats are missing (never report 0 while Farm shows LP)", async () => {
    mocks.getUserBlendBalance.mockResolvedValue(noBlend);
    mocks.getLpBalance.mockResolvedValue("0");
    mocks.getPoolStats.mockResolvedValue(null);
    mocks.getUserLpBalance.mockResolvedValue("1.64");
    mocks.getAquariusPoolStats.mockResolvedValue(null);

    const res = await handleChat({ ...base, message: "my farm position" });
    expect(res.kind).toBe("answer");
    const facts = res.answer?.facts ?? [];
    const aq = facts.find((f) => /aquarius/i.test(f.label));
    expect(aq?.value).toMatch(/1\.64\s*LP/i);
    expect(res.message).not.toMatch(/aquarius lp shares["\s:]*0/i);
  });

  it("blend pool stats is XLM|USDC rates plus a holdings table", async () => {
    mocks.getUserBlendBalance.mockImplementation(async (_addr: string, symbol: string) =>
      symbol === "USDC" ? { bTokenBalance: "85.10", underlyingBalance: "89.86" } : noBlend,
    );
    mocks.getBlendReserveData.mockImplementation(async (symbol: string) =>
      symbol === "USDC"
        ? { supplyAPY: "0.07", borrowAPY: "0.19", utilizationRate: "43.28" }
        : { supplyAPY: "391.12", borrowAPY: "653.11", utilizationRate: "88.69" },
    );
    mocks.getLpBalance.mockResolvedValue("0");
    mocks.getPoolStats.mockResolvedValue(null);
    mocks.getUserLpBalance.mockResolvedValue("1.64");
    mocks.getAquariusPoolStats.mockResolvedValue({ feeFraction: "0.30%" });

    const res = await handleChat({ ...base, message: "what is my blend pool stats?" });
    expect(res.kind).toBe("answer");
    expect(res.answer?.headline).toMatch(/Blend pool stats/i);
    const rates = res.answer?.tables?.[0];
    expect(rates?.columns).toEqual(["", "XLM", "USDC"]);
    expect(rates?.rows.some((r) => r.includes("391.12%") && r.includes("0.07%"))).toBe(true);
    const holdings = res.answer?.tables?.[1];
    expect(holdings?.caption).toMatch(/positions/i);
    expect(holdings?.rows.some((r) => r[0] === "Blend")).toBe(true);
    expect(holdings?.rows.some((r) => r[0] === "Aquarius")).toBe(true);
  });
});

describe("'faucet' questions get guidance instead of the generic capabilities blurb", () => {
  it("routes 'faucet' (and the 'fucet' typo) to guidance", () => {
    for (const ask of ["I have to Faucet AQUSDC", "I have to Fucet AQUSDC", "where is the faucet"]) {
      const r = routeMessage(ask);
      expect(r.kind, ask).toBe("clarify");
      if (r.kind === "clarify") expect(r.message, ask).toMatch(/faucet button/i);
    }
  });
});
