import { describe, expect, it } from "vitest";
import { factualAnswer } from "@/lib/copilot/investigation/answer";
import { blendSupplyApyFromApr } from "@/lib/rate-display";

/**
 * Live, 23 Sep: "what is the XLM supply APY" answered "XLM Earn: 2.759984 % APR; XLM Blend:
 * 173.3838 % APR", while the Earn page showed 2.76% APY and the Farm page 450.29% APY. The
 * numbers were right and the presentation was not — the two venues use different conventions,
 * and Copilot quoted neither of them.
 */
const fact = (venue: "earn" | "blend", label: string, value: string) =>
  ({ id: label, label, value, unit: "% APR", venue, evidenceId: label, sourcePath: label, readAt: 0 });

describe("supply rates are quoted as the APY each venue's page shows", () => {
  it("compounds Blend weekly, the way the Farm page does", () => {
    // 173.3838% APR -> the Farm page showed 450.29% for the same reserve.
    const apy = blendSupplyApyFromApr(1.733838) * 100;
    expect(apy).toBeGreaterThan(450);
    expect(apy).toBeLessThan(451);
  });

  it("quotes both venues as APY, each in its own convention", () => {
    const text = factualAnswer([
      fact("earn", "XLM Earn supply APR", "2.759984"),
      fact("blend", "XLM Blend supply APR", "173.3838"),
    ], "what is the XLM supply APY") ?? "";
    expect(text).toContain("XLM Earn 2.76% APY");   // Earn page: 2.76%
    expect(text).toMatch(/XLM Blend 450\.\d\d% APY/); // Farm page: 450.29%
    expect(text).not.toMatch(/APR/);
  });
});
