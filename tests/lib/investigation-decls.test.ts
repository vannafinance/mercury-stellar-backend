import { describe, expect, it } from "vitest";
import { readCapabilities } from "@/lib/copilot/investigation/catalog";
import { decisionFromFunctionCalls, investigationFunctionDeclarations } from "@/lib/copilot/investigation/decls";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import type { InvestigationScope } from "@/lib/copilot/investigation/types";

const account: InvestigationScope = {
  subject: "user_test", trader: "G_VERIFIED", smartAccount: "C_VERIFIED", network: "testnet",
};

describe("investigation function declarations", () => {
  it("declares scoped reads plus controls and never a write", () => {
    const decls = investigationFunctionDeclarations(readCapabilities(account));
    const names = decls.map((decl) => decl.name);
    expect(names).toContain("can_borrow");
    expect(names).toContain("wallet_balances");
    expect(names.slice(-3)).toEqual(["research_complete", "clarify", "blocked"]);
    expect(names).not.toContain("vanna_borrow");
    expect(names).not.toContain("earn_lend");
    expect(decls.find((decl) => decl.name === "wallet_balances")?.parameters).toBeUndefined();
    expect(decls.find((decl) => decl.name === "can_borrow")?.parameters?.required).toEqual(["asset", "amount"]);
    expect(decls.find((decl) => decl.name === "prices_batch")?.parameters?.properties?.assets?.type).toBe("array");
  });

  it("turns parallel read calls into one inspect batch parseDecision accepts", () => {
    const decision = decisionFromFunctionCalls([
      { name: "wallet_balances", args: {} },
      { name: "account_debt", args: {} },
      { name: "can_borrow", args: { asset: "XLM", amount: "20" } },
    ]);
    expect(parseDecision(decision)).toEqual({
      kind: "inspect",
      reads: [
        { capability: "wallet_balances", args: {} },
        { capability: "account_debt", args: {} },
        { capability: "can_borrow", args: { asset: "XLM", amount: "20" } },
      ],
    });
  });

  it("wraps research_complete args into the existing decision shape", () => {
    const decision = decisionFromFunctionCalls([{
      name: "research_complete",
      args: {
        intent: "answer",
        objective: "Explain health factor",
        constraints: [],
        borrowing: "unspecified",
        findings: [{ summary: "Health factor is collateral over debt.", evidenceIds: [] }],
        openQuestions: [],
      },
    }]);
    expect(parseDecision(decision)).toMatchObject({
      kind: "research_complete",
      goal: { intent: "answer", objective: "Explain health factor", borrowing: "unspecified" },
    });
  });

  it("does not treat a write-shaped function name as a read", () => {
    expect(parseDecision(decisionFromFunctionCalls([{ name: "vanna_borrow", args: { amount: "1000" } }]))).toBeNull();
    expect(parseDecision(decisionFromFunctionCalls([{ name: "earn_lend", args: {} }]))).toBeNull();
  });
});
