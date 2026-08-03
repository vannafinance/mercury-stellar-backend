import { describe, it, expect } from "vitest";
import { isAssistantChat } from "@/lib/copilot/concept";

/**
 * Only the page agent receives the captured page, so a question about the page has to
 * route there. "What am I looking at on this page?" did not — it matched no definitional
 * stem, fell through to the MCP router, and came back as a clarification about a page
 * that was sitting in the request.
 */
describe("assistant routing", () => {
  it("sends page questions to the page agent", () => {
    for (const q of [
      "What am I looking at on this page?",
      "what is this?",
      "explain this page",
      "walk me through this screen",
      "what does this mean",
      "what is shown on my screen",
    ]) {
      expect(isAssistantChat(q), q).toBe(true);
    }
  });

  it("still sends live reads and writes to MCP", () => {
    for (const q of [
      "what's my health factor?",
      "how much do I owe?",
      "lend 10 XLM",
      "price of XLM",
      "show me all earn pools",
      "park 20 XLM then farm 10 BLUSDC at 2x",
    ]) {
      expect(isAssistantChat(q), q).toBe(false);
    }
  });

  it("keeps the Guide's own follow-up chips in the Guide", () => {
    for (const q of [
      "How is that different from what I'd earn on Vanna?",
      "How does Blend differ from Earn?",
      "Farm versus Earn — which is riskier?",
    ]) {
      expect(isAssistantChat(q), q).toBe(true);
    }
  });

  it("a comparison of real assets is still a lookup", () => {
    expect(isAssistantChat("compare the XLM and USDC pools")).toBe(false);
  });

  it("still sends concept questions to the page agent", () => {
    expect(isAssistantChat("what is Blend?")).toBe(true);
    expect(isAssistantChat("how do I deposit XLM as collateral?")).toBe(true);
  });
});
