// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { InvestigationCard } from "@/components/copilot/investigation-card";
import { candidateId } from "@/lib/copilot/investigation/candidate-id";
import { receiptKey } from "@/lib/copilot/workflow-completion";
import type { Candidate } from "@/lib/copilot/investigation/candidates";
import type { ExecutionReceiptSnapshot } from "@/lib/copilot/execution-receipt";
import type { ResearchView } from "@/lib/copilot/investigation/view";

afterEach(cleanup);

/**
 * 24 Oct, live: after a run finished and its summary was written, the plan that was approved stayed on screen below the
 * summary, then turned into a greyed "Expired: ask again" button. The card let go of a finished run only while the
 * workflow was still held; once the workflow was released the same plan came back. The thread's own turn carries the
 * run, so a latest reply whose run is settled and summarised has no plan left to approve.
 */
const receipt = { workflowId: "run", network: "testnet", status: "completed", steps: [
  { operation: "deposit_collateral", label: "Deposit 10 XLM", asset: "XLM", amount: "10", status: "settled", txHash: "a".repeat(64), settledLedger: 123 },
] } satisfies ExecutionReceiptSnapshot;
const completion = { workflowId: "run", receiptKey: receiptKey(receipt), generatedAt: 1, source: "model" as const };
const plan: Candidate = {
  id: candidateId("composed", "le.SOUSDC"), kind: "composed", label: "Lend SOUSDC to Earn", borrows: false, asset: "SOUSDC", venue: "earn",
  netAprPct: null, supplyAprPct: "4.2", supplyApyPct: "4.2", netApyPct: null, legs: [], finalHealthFactor: null,
  amountUsd: "680", evidenceIds: ["e1"], amountBasis: "stated",
};
const result: ResearchView = {
  status: "researched", message: "Approve to run.", originalRequest: "supply my usdc", refinements: [], understanding: { objective: "Supply", constraints: [], borrowing: "unspecified" },
  question: null, facts: [], capacity: null, candidates: { feasible: [plan], rejected: [] }, rateComparisons: [], checks: [], warnings: [],
  scope: { wallet: "G", smartAccount: "C", network: "testnet" }, continuation: "sealed", executionAllowed: false,
};
const show = (turns: Parameters<typeof InvestigationCard>[0]["turns"]) =>
  render(<InvestigationCard prompt="supply my usdc" result={result} progress={null} loading={false} error={null} workflow={null} omitTranscript turns={turns} onApprove={() => {}} onApproveCandidate={() => {}} wallet="G" accountAvailable />);

describe("a finished run leaves no plan to approve", () => {
  it("shows no Approve button once the latest reply's run is settled and summarised, even with no workflow held", () => {
    show([{ role: "user", text: "supply my usdc" }, { role: "assistant", text: "Done.", executionReceipt: receipt, completion }]);
    expect(screen.queryByRole("button", { name: /approve|expired/i })).toBeNull();
  });
  it("still shows the plan for a reply that has not run", () => {
    show([{ role: "user", text: "supply my usdc" }, { role: "assistant", text: "Approve to run." }]);
    expect(screen.getByRole("button", { name: /approve/i })).toBeTruthy();
  });
});
