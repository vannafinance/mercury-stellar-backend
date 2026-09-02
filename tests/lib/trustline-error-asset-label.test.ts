/**
 * `classifyTrustlineFailure` is itself asset-aware, but `humanizeMcpWriteError`'s only
 * call site never passed an asset — so a HostError #13 on ANY token always read "XLM is
 * not ready in your wallet", seen live on "borrow 2000 BLUSDC" / "borrow 1k BLUSDC" /
 * "borrow 1,000 BLUSDC". `readinessDisplayAsset(null)` defaults to "XLM", which is exactly
 * how the wrong label slipped in unnoticed.
 */
import { describe, expect, it } from "vitest";
import { humanizeMcpWriteError } from "@/lib/copilot/mcp-write";

const HOSTERROR_13 = "Simulation failed: HostError: Error(Contract, #13) trustline entry is missing";

describe("humanizeMcpWriteError — a trustline failure names the real asset", () => {
  it("names BLUSDC when that is the asset that hit HostError #13", () => {
    const msg = humanizeMcpWriteError({ message: HOSTERROR_13 }, "vanna_borrow", {
      asset: "USDC",
      trader: "G".padEnd(56, "A"),
    });
    expect(msg).toMatch(/BLUSDC/);
    expect(msg).not.toMatch(/\bXLM\b/);
  });

  it("names AQUSDC, not XLM, when that is the asset", () => {
    const msg = humanizeMcpWriteError({ message: HOSTERROR_13 }, "vanna_borrow", {
      asset: "AQUSDC",
      trader: "G".padEnd(56, "A"),
    });
    expect(msg).toMatch(/AQUSDC/);
    expect(msg).not.toMatch(/\bXLM\b/);
  });

  it("still falls back to XLM when no asset context is available at all", () => {
    const msg = humanizeMcpWriteError({ message: HOSTERROR_13 }, "vanna_borrow");
    expect(msg).toMatch(/XLM/);
  });
});
