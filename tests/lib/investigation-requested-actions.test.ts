import { describe, expect, it } from "vitest";
import { compileRequestedActions } from "@/lib/copilot/investigation/requested-actions";
import type { InvestigationScope } from "@/lib/copilot/investigation/types";

const SCOPE: InvestigationScope = {
  subject: "user",
  trader: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smartAccount: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  network: "testnet",
};

describe("compileRequestedActions", () => {
  it("compiles a planner-nominated repay whose amount is in the user text", () => {
    const message = "repay 1 XLM from my account";
    const steps = compileRequestedActions({
      intent: "strategy",
      objective: message,
      constraints: [],
      borrowing: "forbidden",
      actions: [{ op: "repay", asset: "XLM", amount: "1", sourceQuote: message }],
    }, [message], SCOPE);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ op: "repay", asset: "XLM", amount: "1", tool: "vanna_repay" });
  });

  it("falls through when the amount is not in the user text or the asset is unknown", () => {
    const message = "repay some XLM";
    expect(compileRequestedActions({
      intent: "strategy",
      objective: message,
      constraints: [],
      borrowing: "forbidden",
      actions: [{ op: "repay", asset: "XLM", amount: "1", sourceQuote: message }],
    }, [message], SCOPE)).toEqual([]);
    expect(compileRequestedActions({
      intent: "strategy",
      objective: "repay 1 NOTCOIN",
      constraints: [],
      borrowing: "forbidden",
      actions: [{ op: "repay", asset: "NOTCOIN", amount: "1", sourceQuote: "repay 1 NOTCOIN" }],
    }, ["repay 1 NOTCOIN"], SCOPE)).toEqual([]);
  });
});
