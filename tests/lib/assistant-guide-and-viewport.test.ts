import { describe, expect, it } from "vitest";
import { normalizeGuideAnswer, guideAnswerToText } from "@/lib/copilot/guide-schema";
import { clampToViewport } from "@/components/copilot/assistant-launcher";
import { handleChat } from "@/lib/copilot/handle";


describe("Vanna Assist structured guide schema & viewport clamping", () => {
  it("normalizes highlights, steps, terms, copilotHandoffPrompt, and clientTools", () => {
    const raw = {
      question: "How do I check my health factor and go to Margin?",
      summary: "Your Health Factor is Gross Collateral divided by Debt, with liquidation at 1.10.",
      highlights: [
        { label: "Liquidation Floor", value: "1.10", tone: "warn" },
        { label: "Current HF", value: "2.45", tone: "good" },
      ],
      sections: [
        {
          heading: "How Health Factor works",
          body: "Vanna calculates Health Factor from total collateral and borrowed debt.",
          formula: "Health Factor = Gross Collateral / Debt",
          bullets: ["Above 1.10 is healthy", "At or below 1.10 is eligible for liquidation"],
          steps: ["Open the Margin page", "Inspect your Health Factor badge"],
        },
      ],
      terms: [
        { term: "Health Factor", short: "Ratio of gross collateral value to borrowed debt." },
      ],
      followUps: ["What happens during liquidation?"],
      copilotHandoffPrompt: "Check my live margin health factor and borrowing capacity",
      clientTools: [{ name: "navigateToRoute", path: "/margin" }],
    };

    const parsed = normalizeGuideAnswer(raw, "fallback");
    expect(parsed).not.toBeNull();
    expect(parsed?.highlights).toEqual([
      { label: "Liquidation Floor", value: "1.10", tone: "warn" },
      { label: "Current HF", value: "2.45", tone: "good" },
    ]);
    expect(parsed?.sections[0]?.steps).toEqual([
      "Open the Margin page",
      "Inspect your Health Factor badge",
    ]);
    expect(parsed?.copilotHandoffPrompt).toBe(
      "Check my live margin health factor and borrowing capacity",
    );
    expect(parsed?.clientTools).toEqual([{ name: "navigateToRoute", path: "/margin" }]);

    const text = guideAnswerToText(parsed!);
    expect(text).toContain("Liquidation Floor: 1.10");
    expect(text).toContain("1. Open the Margin page");
  });

  it("clamps floating Assist coordinates strictly within the website viewport bounds", () => {
    const vw = 1280;
    const vh = 800;
    const w = 428;
    const h = 620;

    // Attempt to drag far outside top-left
    const topLeft = clampToViewport(-500, -300, w, h, vw, vh);
    expect(topLeft.x).toBe(12);
    expect(topLeft.y).toBe(64); // kept below top navbar

    // Attempt to drag far outside bottom-right
    const bottomRight = clampToViewport(5000, 5000, w, h, vw, vh);
    expect(bottomRight.x).toBe(vw - w - 12);
    expect(bottomRight.y).toBe(vh - h - 12);

    // Valid in-bounds position stays untouched
    const inside = clampToViewport(300, 120, w, h, vw, vh);
    expect(inside).toEqual({ x: 300, y: 120 });
  });

  it("includes copilotHandoffPrompt when redirecting an action from the Assist surface", async () => {
    const res = await handleChat({
      user_id: "guest",
      tier: "free",
      smart_account: null,
      surface: "assistant",
      message: "deposit 5 XLM as collateral",
    });
    expect(res.kind).toBe("blocked");
    expect(res.intent?.template_id).toBe("assistant_surface_redirect");
    expect((res.data as Record<string, unknown>)?.copilotHandoffPrompt).toBe(
      "deposit 5 XLM as collateral",
    );
  });
});
