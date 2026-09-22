import { describe, expect, it } from "vitest";
import { findAsset, firstAssetByPosition, routeMessage } from "@/lib/copilot/router";
import { ambiguousUsdcSlot } from "@/lib/copilot/mcp-write";
import { handleChat } from "@/lib/copilot/handle";

describe("redeem XLM from earn — multiplication sign normalization and missing asset handling", () => {
  it("resolves XLM when user typed a standard 'x' with space", () => {
    expect(findAsset("redeem 10 xlm from earn")).toBe("XLM");
    expect(firstAssetByPosition("redeem 10 xlm from earn")).toBe("XLM");
  });

  it("resolves XLM when user typed multiplication sign '×' instead of 'x'", () => {
    expect(findAsset("redeem 10×lm from earn")).toBe("XLM");
    expect(firstAssetByPosition("redeem 10×lm from earn")).toBe("XLM");
    expect(findAsset("10×lm")).toBe("XLM");
    expect(findAsset("×LM")).toBe("XLM");
  });

  it("routes 'redeem 10 xlm from earn' to redeem XLM", () => {
    const r = routeMessage("redeem 10 xlm from earn");
    expect(r.kind).toBe("write");
    if (r.kind === "write") {
      expect(r.op).toBe("redeem");
      expect(r.asset).toBe("XLM");
      expect(r.amount).toBe(10);
    }
  });

  it("routes 'redeem 10×lm from earn' to redeem XLM instead of bare USDC", () => {
    const r = routeMessage("redeem 10×lm from earn");
    expect(r.kind).toBe("write");
    if (r.kind === "write") {
      expect(r.op).toBe("redeem");
      expect(r.asset).toBe("XLM");
      expect(r.amount).toBe(10);
    }
  });

  it("asks which asset to redeem when asset is missing, without defaulting to USDC", () => {
    const r = routeMessage("redeem 10 from earn");
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") {
      expect(r.template_id).toBe("redeem_amount_and_asset");
      expect(r.message).toContain("which asset");
      expect(r.message).not.toContain("Which USDC");
    }
  });

  it("ambiguousUsdcSlot returns null when user text does not contain bare USDC", () => {
    // Action has asset "USDC" but user said "redeem 10×lm from earn"
    expect(
      ambiguousUsdcSlot({ asset: "USDC" }, "redeem 10×lm from earn"),
    ).toBeNull();

    // User text actually contains bare USDC
    expect(
      ambiguousUsdcSlot({ asset: "USDC" }, "redeem 10 USDC from earn"),
    ).toBe("collateral");
  });

  it("handleChat on 'redeem 10×lm from earn' does not prompt 'Which USDC do you want to use?'", async () => {
    const res = await handleChat({
      user_id: "test-trader",
      smart_account: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      message: "redeem 10×lm from earn",
    });

    expect(res.message).not.toContain("Which USDC do you want to use?");
    expect(res.message).not.toContain("Which USDC");
    if (res.kind === "clarification") {
      expect(res.intent?.template_id).not.toBe("clarify_usdc_variant");
    }
  });
});
