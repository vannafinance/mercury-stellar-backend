/**
 * Owner, 29 Sep: the health factor is the Margin page's (2.32 on the test account), not the
 * contract-basis ratio (1.83). Plan cards showed "1.83 → …". Sizing still runs on the contract
 * basis - the stricter figure - and only the displayed before/after follow the page, moved by
 * exactly the collateral and debt the sized legs move. Figures are the live 29 Sep reads.
 */
import { describe, expect, it } from "vitest";
import { displayHealthFactors, sizeLegs } from "@/lib/copilot/investigation/sizing";

const CONTRACT = { grossCollateralUsd: "3937.89", debtUsd: "2151.93" };
const SITE = { grossCollateralUsd: "5001.91", debtUsd: "2151.93" };

describe("plan-card health factor on the Margin page's basis", () => {
  it("starts from the page's ratio and moves by the sized legs", () => {
    const sized = sizeLegs(CONTRACT, [
      { op: "deposit_collateral", label: "deposit", amountUsd: "100" },
      { op: "borrow", label: "borrow", amountUsd: "50" },
    ], null);
    expect(sized.ok).toBe(true);
    if (!sized.ok) return;
    const shown = displayHealthFactors(CONTRACT, SITE, sized.legs)!;
    expect(Number(shown.before)).toBeCloseTo(5001.91 / 2151.93, 6); // 2.32, as the page shows
    expect(Number(shown.after)).toBeCloseTo((5001.91 + 100 + 50) / (2151.93 + 50), 6);
    // The sizer's own figure is untouched: the contract basis still decides the floor.
    expect(Number(sized.finalHealthFactor)).toBeCloseTo((3937.89 + 150) / (2151.93 + 50), 6);
  });

  it("reports no health factor once the plan clears the debt, and none without page figures", () => {
    const repaid = sizeLegs(CONTRACT, [{ op: "repay", label: "repay", amountUsd: "2151.93" }], null);
    expect(repaid.ok && displayHealthFactors(CONTRACT, SITE, repaid.legs)?.after).toBeNull();
    const sized = sizeLegs(CONTRACT, [{ op: "deposit_collateral", label: "deposit", amountUsd: "10" }], null);
    expect(sized.ok && displayHealthFactors(CONTRACT, null, sized.legs)).toBeNull();
  });

  it("shows the page's figure unchanged for a plan that moves no margin value", () => {
    const shown = displayHealthFactors(CONTRACT, SITE, [])!;
    expect(shown.before).toBe(shown.after);
    expect(Number(shown.before)).toBeCloseTo(2.3244, 3);
  });
});
