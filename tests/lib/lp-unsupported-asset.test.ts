import { describe, expect, it } from "vitest";
import { staticStepBlocker } from "@/lib/copilot/mcp-write";
import { handleChat } from "@/lib/copilot/handle";

describe("Unsupported LP Asset Refusal (PDF L5)", () => {
  it("refuses add_liquidity for assets without LP venue via staticStepBlocker", () => {
    const blocked = staticStepBlocker("add_liquidity", { asset: "EURC" });
    expect(blocked).toBe(
      "EURC has no LP venue. Supported LP pairs are XLM/AQUSDC on aquarius and XLM/SOUSDC on soroswap.",
    );
  });

  it("refuses add_liquidity when EURC is passed as token_b", () => {
    const blocked = staticStepBlocker("add_liquidity", { token_a: "XLM", token_b: "EURC" });
    expect(blocked).toBe(
      "EURC has no LP venue. Supported LP pairs are XLM/AQUSDC on aquarius and XLM/SOUSDC on soroswap.",
    );
  });

  it("refuses remove_liquidity for EURC", () => {
    const blocked = staticStepBlocker("remove_liquidity", { asset: "EURC" });
    expect(blocked).toBe(
      "EURC has no LP venue. Supported LP pairs are XLM/AQUSDC on aquarius and XLM/SOUSDC on soroswap.",
    );
  });

  it("allows supported LP assets (AQUSDC, SOUSDC)", () => {
    expect(staticStepBlocker("add_liquidity", { token_a: "XLM", token_b: "AQUSDC" })).toBeNull();
    expect(staticStepBlocker("add_liquidity", { token_a: "XLM", token_b: "SOUSDC" })).toBeNull();
  });

  it("routes 'provide EURC liquidity' to blocked response naming supported LP pairs", async () => {
    const res = await handleChat({
      user_id: "GD4BQRX747NPDH",
      message: "provide EURC liquidity",
      smart_account: "C_SMART_ACCOUNT",
    });
    expect(res.kind).toBe("blocked");
    expect(res.message).toBe(
      "EURC has no LP venue. Supported LP pairs are XLM/AQUSDC on aquarius and XLM/SOUSDC on soroswap.",
    );
  });
});
