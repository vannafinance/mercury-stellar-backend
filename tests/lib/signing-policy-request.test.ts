import { describe, expect, it } from "vitest";
import { anchoredSigningPolicyRequest, parseSigningPolicyRequest } from "@/lib/copilot/investigation/signing-policy-request";
import { decisionFromFunctionCalls } from "@/lib/copilot/investigation/decls";
import { parseDecision } from "@/lib/copilot/investigation/decision";
const message = "set my daily budget to $5,000 and per transaction to $0.10";
const request = { action: "configure", mode: "custom", unit: "testnet_usd", maxPerTx: "0.10", maxPerDay: "5000", sourceQuote: message };
describe("signing policy requests are review-only", () => {
  it("anchors semantic requests and their numbers without inferring approval from phrasing", () => {
    expect(anchoredSigningPolicyRequest(request, message)).toEqual(request);
    expect(anchoredSigningPolicyRequest(request, "yes" )).toBeNull();
    expect(anchoredSigningPolicyRequest({ ...request, maxPerTx: "1000" }, message)).toBeNull();
    expect(anchoredSigningPolicyRequest({ ...request, maxPerTx: "1", maxPerDay: undefined, sourceQuote: "use -1" }, "use -1")).toBeNull();
    expect(parseSigningPolicyRequest({ ...request, usd_budget_approved: true })).toBeNull();
    expect(parseSigningPolicyRequest({ ...request, maxPerTx: "0.0000001" })).toBeNull();
  });
  it("carries typed request fields through the model function adapter without an execution or grant", () => {
    const raw = decisionFromFunctionCalls([{ name: "research_complete", args: {
      intent: "answer", objective: "Review signing limits", constraints: [], borrowing: "unspecified", signingPolicy: request,
      findings: [{ summary: "Review the requested limits in the form before applying them.", evidenceIds: [] }], openQuestions: [],
    } }]);
    const decision = parseDecision(raw);
    expect(decision?.kind).toBe("research_complete");
    if (decision?.kind !== "research_complete") throw new Error("Expected review handoff");
    expect(decision.goal.signingPolicy).toEqual(request);
    expect(decision.goal.actions).toBeUndefined();
    expect(decision.goal.write).toBeUndefined();
    expect(decision.plans).toBeUndefined();
    expect(parseDecision({ ...raw as object, goal: { ...decision.goal, write: { op: "create_account", sourceQuote: message } } })).toBeNull();
    expect(parseDecision({ ...raw as object, goal: { ...decision.goal, portfolioExit: { destination: "wallet", sourceQuote: message } } })).toBeNull();
    expect(parseDecision({ ...raw as object, goal: { ...decision.goal, allocationRequest: { sourceQuote: message } } })).toBeNull();
  });
});
