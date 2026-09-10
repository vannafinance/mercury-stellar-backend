import { describe, expect, it } from "vitest";
import { researchCodec } from "@/lib/copilot/investigation/continuation";
import { compactResearchEvidence, researchEvidenceReusable } from "@/lib/copilot/investigation/evidence";
import { normalizeResearchFacts } from "@/lib/copilot/investigation/normalize";
import type { Observation } from "@/lib/copilot/investigation/types";

const scope = { subject: "alice", trader: "wallet", smartAccount: "account", network: "testnet" };
describe("sealed investigation context", () => {
  it("retains the whole objective while binding every identity dimension and server", () => {
    const codec = researchCodec("a".repeat(32), "mcp-a", () => 1000);
    const token = codec.seal(scope, ["Keep HF above 1.3", "Use both assets"], "Which USDC?");
    expect(codec.open(token, scope).messages).toEqual(["Keep HF above 1.3", "Use both assets"]);
    expect(codec.read(token).scope.subject).toBe("alice");
    for (const change of [{ subject: "bob" }, { trader: "other" }, { smartAccount: "other" }, { network: "mainnet" }])
      expect(() => codec.open(token, { ...scope, ...change })).toThrow();
    expect(() => researchCodec("a".repeat(32), "mcp-b", () => 1000).open(token, scope)).toThrow();
    expect(() => researchCodec("a".repeat(32), "mcp-a", () => 1_801_000).open(token, scope)).toThrow();
    const parts = token.split(".");
    parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
    expect(() => codec.open(parts.join("."), scope)).toThrow();
  });

  it("seals compact evidence so propose can reuse it, and still opens older tokens without it", () => {
    const codec = researchCodec("a".repeat(32), "mcp-a", () => 1000);
    const evidence = compactResearchEvidence([
      {
        id: "e1", capability: "asset_price", args: { asset: "BLUSDC", extra: "drop" },
        observedAt: 1000, status: "ok",
        data: { price_usd: "1", noise: "no" },
      },
    ], { floor: "1.30", grossCollateralUsd: "317.00", debtUsd: "217.12", healthFactor: "1.46", maxBorrowUsd: "115.81" }, 1000);
    const withEvidence = codec.seal(scope, ["Keep HF above 1.3"], null, evidence);
    const prior = codec.read(withEvidence);
    expect(prior.evidence?.capacity?.floor).toBe("1.30");
    expect(prior.evidence?.observations[0]).toMatchObject({
      capability: "asset_price", args: { asset: "BLUSDC" }, data: { price_usd: "1" },
    });
    expect(prior.evidence?.observations[0].args).not.toHaveProperty("extra");
    expect(researchEvidenceReusable(prior.evidence, 1000)).toBe(true);
    expect(researchEvidenceReusable(prior.evidence, 61_001)).toBe(false);

    const legacy = codec.seal(scope, ["Keep HF above 1.3"], null);
    expect(codec.read(legacy).evidence).toBeUndefined();
    expect(researchEvidenceReusable(undefined, 1000)).toBe(false);
  });
});

describe("financial evidence normalization", () => {
  const observation = (capability: string, data: Observation["data"]): Observation => ({ id: capability, capability, args: { asset: "BLUSDC" }, observedAt: 1000, status: "ok", data });
  it("does not count the native XLM wrapper twice or derive HF from ambiguous collateral", () => {
    const result = normalizeResearchFacts([
      observation("wallet_balances", { assets: [{ symbol: "XLM", balance: "10" }, { symbol: "XLM_SAC", balance: "10" }] }),
      observation("account_health", { collateral_usd: "130", debt_usd: "100" }),
    ]);
    expect(result.facts.filter((fact) => fact.venue === "wallet")).toHaveLength(1);
    expect(result.facts.some((fact) => fact.unit === "HF")).toBe(false);
  });
  it("labels Earn's APY alias as APR and does not invent prices after errors", () => {
    const result = normalizeResearchFacts([
      observation("earn_market", { supply_apy_pct: "5.123456789" }),
      { ...observation("asset_price", { price_usd: "1" }), status: "error" },
    ]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({ unit: "% APR", value: "5.123456789", sourcePath: "supply_apy_pct" });
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  it("cites a can_withdraw preflight as an audited eligibility fact", () => {
    const result = normalizeResearchFacts([{
      id: "e2", capability: "can_withdraw", args: { asset: "XLM", amount: "100" },
      observedAt: 1000, status: "ok", data: { allowed: true, symbol: "XLM", amount: "100" },
    }]);
    expect(result.facts).toEqual([expect.objectContaining({
      label: "withdraw 100 XLM", value: "allowed", sourcePath: "allowed", venue: "margin", evidenceId: "e2",
    })]);
  });
  /**
   * `enabled: true` is a configuration flag; the Sign Service reports the live session
   * separately and can contradict it. Calling an expired delegation "Active" is the one
   * claim on this card that could persuade someone the server will carry a plan out
   * unattended when in fact every leg still needs their wallet.
   */
  it("does not report a configured-but-dead delegated session as active authority", () => {
    for (const status of ["session_expired", "no_active_session", "over_daily_cap", "unauthorized"]) {
      const result = normalizeResearchFacts([observation("signing_status", { enabled: true, status })]);
      const fact = result.facts.find((entry) => entry.venue === "signing");
      expect(fact?.value).toBe(`Not usable (${status.replaceAll("_", " ")})`);
      expect(result.warnings.some((warning) => /needs your wallet signature/.test(warning))).toBe(true);
    }
  });

  it("still reports a genuinely active session as active, and an off one as off", () => {
    const active = normalizeResearchFacts([observation("signing_status", { enabled: true, status: "active" })]);
    expect(active.facts.find((entry) => entry.venue === "signing")?.value).toBe("Active");
    expect(active.warnings).toEqual([]);
    // A server that reports no status at all is taken at its word rather than doubted.
    const bare = normalizeResearchFacts([observation("signing_status", { enabled: true })]);
    expect(bare.facts.find((entry) => entry.venue === "signing")?.value).toBe("Active");
    const off = normalizeResearchFacts([observation("signing_status", { enabled: false, status: "disabled" })]);
    expect(off.facts.find((entry) => entry.venue === "signing")?.value).toBe("Off");
    expect(off.warnings).toEqual([]);
  });
});
