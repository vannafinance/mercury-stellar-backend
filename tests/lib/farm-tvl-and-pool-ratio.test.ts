/**
 * Reported live, three related routing gaps under "everyday phrasing had no route":
 *
 * 1. "What is my TVL in Farm Section" fell through to the generic capabilities blurb —
 *    TVL is the Farm page's own label ("Your Deposit TVL") for the same gross Blend +
 *    Aquarius/Soroswap-LP total `farmPositionAnswer` already answers with; only the
 *    synonym was missing from `asksAboutHoldings`.
 * 2. "What is XLM to SoUSDC Ratio in farm Soroswap pool?" fell through entirely — no
 *    route ever asked an AMM pool's live reserve ratio directly.
 * 3. "What is Current Rate of bXLM?" was REJECTED by the domain firewall as off-topic —
 *    bXLM is Blend's own bToken symbol for a supplied XLM position, a real in-domain
 *    concept the firewall's vocabulary list never recognised.
 */
import { describe, expect, it, vi } from "vitest";
import { routeMessage } from "@/lib/copilot/router";
import { evaluateDomainFirewall } from "@/lib/copilot/domain-firewall";
import { isAssistantChat } from "@/lib/copilot/concept";

describe("'What is my TVL in Farm Section' routes to the farm-position read", () => {
  it("recognises TVL as a holdings question", () => {
    const r = routeMessage("What is my TVL in Farm Section");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_farm_position");
  });

  it("also recognises 'total value locked' spelled out", () => {
    const r = routeMessage("what's my total value locked in farm");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_farm_position");
  });
});

describe("a direct pool-ratio question routes to a live reserve read", () => {
  it("Soroswap: 'What is XLM to SoUSDC Ratio in farm Soroswap pool?'", () => {
    const r = routeMessage("What is XLM to SoUSDC Ratio in farm Soroswap pool?");
    expect(r.kind).toBe("read");
    if (r.kind === "read") {
      expect(r.template_id).toBe("query_pool_ratio");
      expect(r.args).toMatchObject({ venue: "soroswap" });
    }
  });

  it("Aquarius: 'what is the ratio in the aquarius pool'", () => {
    const r = routeMessage("what is the ratio in the aquarius pool");
    expect(r.kind).toBe("read");
    if (r.kind === "read") {
      expect(r.template_id).toBe("query_pool_ratio");
      expect(r.args).toMatchObject({ venue: "aquarius" });
    }
  });
});

describe("'bXLM' is a recognised in-domain concept, not off-topic chat", () => {
  it("the domain firewall does not reject a bXLM question", () => {
    const fw = evaluateDomainFirewall("What is Current Rate of bXLM?");
    expect(fw.allow).toBe(true);
  });

  it("routes to the Blend reserve-stats read", () => {
    const r = routeMessage("What is Current Rate of bXLM?");
    expect(r.kind).toBe("read");
    if (r.kind === "read") {
      expect(r.template_id).toBe("query_blend");
      expect(r.args).toMatchObject({ symbol: "XLM" });
    }
  });

  it("bUSDC resolves to the USDC reserve, not XLM", () => {
    const r = routeMessage("what rate does bUSDC pay");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.args).toMatchObject({ symbol: "USDC" });
  });

  it("THE LIVE BUG: never classified as a conceptual explainer question", () => {
    // A THIRD independent asset-recognition list (concept.ts's ASSET_SYMBOL) had the same
    // gap — "rate" satisfies MARKET_NOUN, but `\bXLM\b` can't match inside "bXLM", so the
    // live-data override never fired and this was answered by the generic Guide explainer
    // ("bXLM is a tokenized representation...") instead of the actual current rate.
    expect(isAssistantChat("What is Current Rate of bXLM?")).toBe(false);
  });
});

const mocks = vi.hoisted(() => ({
  getPoolStats: vi.fn(),
  getAquariusPoolStats: vi.fn(),
}));
vi.mock("@/lib/soroswap-utils", () => ({
  SoroswapService: { getPoolStats: mocks.getPoolStats },
}));
vi.mock("@/lib/aquarius-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aquarius-utils")>();
  return {
    ...actual,
    AquariusService: { ...actual.AquariusService, getAquariusPoolStats: mocks.getAquariusPoolStats },
  };
});

import { handleChat } from "@/lib/copilot/handle";

const base = {
  user_id: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  tier: "free" as const,
  surface: "copilot" as const,
};

describe("poolRatioAnswer reads live reserves, never guesses", () => {
  it("Soroswap ratio matches the pool's own reserves", async () => {
    mocks.getPoolStats.mockResolvedValue({ reserveXLM: "1000", reserveUSDC: "140" });
    const res = await handleChat({ ...base, message: "What is XLM to SoUSDC Ratio in farm Soroswap pool?" });
    expect(res.kind).toBe("answer");
    // Headline leads with the direction asked for; the reverse direction lives in its
    // own fact row, not crammed into the same run-on sentence (reported live).
    expect(res.message).toMatch(/1 XLM ≈ 0\.1400 SOUSDC/);
    expect(res.answer?.facts).toContainEqual({ label: "1 SOUSDC", value: "7.1429 XLM" });
  });

  it("a pool read failure answers honestly instead of inventing a ratio", async () => {
    mocks.getPoolStats.mockResolvedValue(null);
    const res = await handleChat({ ...base, message: "What is XLM to SoUSDC Ratio in farm Soroswap pool?" });
    expect(res.kind).toBe("unavailable");
  });
});
