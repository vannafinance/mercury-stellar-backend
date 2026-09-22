import { describe, expect, it } from "vitest";
import { staticStepBlocker, humanizeMcpWriteError } from "@/lib/copilot/mcp-write";
import { humanizeStroopCounts } from "@/lib/copilot/execution-copy";

describe("F5: Borrow refusals, error humanization, and budget limits", () => {
  it("refuses borrow for an asset with no marginSymbol with a clean app sentence (un-enumerated USDT)", () => {
    // USDT has marginSymbol: null and was NOT named in the bug report or fix
    const refusal = staticStepBlocker("borrow", { asset: "USDT" });
    expect(refusal).toBeDefined();
    expect(refusal).toMatch(/USDT cannot be borrowed/i);
    expect(refusal).toMatch(/Supported margin assets are/i);
    expect(refusal).toContain("XLM");
    expect(refusal).toContain("BLUSDC");
  });

  it("refuses borrow for AQUA with an app sentence rather than leaking Python error", () => {
    const refusal = staticStepBlocker("borrow", { asset: "AQUA" });
    expect(refusal).toBeDefined();
    expect(refusal).toMatch(/AQUA cannot be borrowed/i);
    expect(refusal).not.toMatch(/Unknown token symbol/i);
  });

  it("allows borrow for assets with valid marginSymbol", () => {
    expect(staticStepBlocker("borrow", { asset: "BLUSDC" })).toBeNull();
    expect(staticStepBlocker("borrow", { asset: "XLM" })).toBeNull();
    expect(staticStepBlocker("borrow", { asset: "AQUSDC" })).toBeNull();
  });

  it("does not corrupt whole token counts into fractional numbers or duplicate symbols in humanizeStroopCounts", () => {
    const message = "Borrow of 1000000 USDC on CBOQAN5N rejected by risk engine pre-flight check.";
    const result = humanizeStroopCounts(message, "USDC");
    // Must NOT scale 1,000,000 to 0.1
    expect(result).not.toContain("0.1");
    // Must NOT duplicate USDC
    expect(result).not.toMatch(/USDC\s+USDC/i);
    // Must preserve 1000000 USDC
    expect(result).toContain("1000000 USDC");
  });

  it("humanizeMcpWriteError masks raw C-account contract addresses and maps risk errors", () => {
    const errorMsg = "Borrow of 1000000 USDC on CBOQAN5NP3L2Z6K9X4M7W1V8R5T0Y3E2Q1A4S7D0F3G6H9J2K5L8Z1X4 rejected by risk engine pre-flight check.";
    const humanized = humanizeMcpWriteError(
      { error: "health_check_failed", message: errorMsg },
      "vanna_margin_trade",
      { asset: "USDC" }
    );
    // Must not leak the raw 56-character contract address
    expect(humanized).not.toContain("CBOQAN5NP3L2Z6K9X4M7W1V8R5T0Y3E2Q1A4S7D0F3G6H9J2K5L8Z1X4");
    expect(humanized).toContain("on your margin account");
    expect(humanized).toContain("1000000 USDC");
  });

  it("maps settle account Soroban budget limit errors to a clean app sentence", () => {
    const humanized = humanizeMcpWriteError(
      { error: "simulation_failed", message: "HostError: Error(Budget, ExceededLimit)" },
      "vanna_settle_account"
    );
    expect(humanized).not.toMatch(/^Simulation failed: HostError/i);
    expect(humanized).toMatch(/budget limit/i);
    expect(humanized).toMatch(/settl/i);
  });
});
