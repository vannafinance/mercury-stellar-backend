// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatTurns } from "@/components/copilot/chat-message";
import { InvestigationCard } from "@/components/copilot/investigation-card";
import { receiptKey } from "@/lib/copilot/workflow-completion";
import type { ExecutionReceiptSnapshot } from "@/lib/copilot/execution-receipt";
import type { WorkflowView } from "@/lib/copilot/workflow/types";
import type { ResearchView } from "@/lib/copilot/investigation/view";
afterEach(cleanup);
const r: ExecutionReceiptSnapshot = { workflowId: "run", network: "testnet", status: "completed", steps: [
  { operation: "deposit_collateral", label: "Deposit 10 XLM", asset: "XLM", amount: "10", status: "settled", txHash: "a".repeat(64), settledLedger: 123 },
  { operation: "borrow", label: "Borrow 2 BLUSDC", asset: "BLUSDC", amount: "2", status: "settled", txHash: "b".repeat(64), settledLedger: 124 },
] };
const completion = { workflowId: r.workflowId, receiptKey: receiptKey(r), generatedAt: 1, source: "model" as const };

describe("whole-run summary presentation", () => {
  it("removes the completed execution section and stale plan headroom from the live investigation card", () => {
    const result: ResearchView = { status: "researched", message: "Approve", originalRequest: "Deposit", refinements: [], understanding: null, question: null,
      facts: [], checks: [], warnings: [], executionAllowed: false, continuation: "sealed", scope: { wallet: null, smartAccount: null, network: "testnet" },
      capacity: { floor: "1.3", grossCollateralUsd: "100", debtUsd: "20", healthFactor: "5", maxBorrowUsd: "10" } };
    const workflow: WorkflowView = { id: r.workflowId, revision: 3, digest: "d", status: "completed", objective: "Deposit", expiresAt: 0, assumptions: [], constraints: [], slippageAccepted: false,
      message: "Finished", steps: r.steps.map((s, i) => ({ id: String(i), op: s.operation, asset: s.asset, amount: s.amount, label: s.label!, status: s.status, txHash: s.txHash ?? undefined, settledLedger: s.settledLedger ?? undefined })) };
    const { container } = render(<InvestigationCard prompt="Deposit" result={result} progress={null} loading={false} error={null} workflow={workflow} omitTranscript
      turns={[{ role: "user", text: "Deposit" }, { role: "assistant", text: "Completed", executionReceipt: r, completion }]} />);
    expect(container.textContent).not.toContain("Headroom at your");
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.queryByText("EXECUTION PROGRESS")).toBeNull();
  });
  it("renders one summary with verified transaction bullets, without an execution card", () => {
    render(<ChatTurns turns={[{ role: "assistant", text: "Completed your requested actions.", executionReceipt: r, completion }]} />);
    const list = screen.getByRole("list", { name: "Settled transactions" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getAllByRole("link")[0].getAttribute("href")).toBe(`https://stellar.expert/explorer/testnet/tx/${"a".repeat(64)}`);
    expect(list.textContent).toContain("Ledger 123");
    // The link reads as a short hash, not the whole 64 characters; the whole hash stays in its title and name.
    expect(within(list).getAllByRole("link")[0].textContent).toBe("aaaaaa…aaaa ↗");
    expect(within(list).getAllByRole("link")[0].getAttribute("title")).toBe("a".repeat(64));
    // Links and the ledger number are set apart in green, the same token the execution card uses.
    expect(within(list).getAllByRole("link")[0].className).toContain("--cp-emerald");
    expect(list.querySelector("span span")?.className).toContain("--cp-emerald");
    expect(screen.queryByText("EXECUTION PROGRESS")).toBeNull();
  });
  it("preserves execution cards for incomplete runs or legacy receipts without completion metadata", () => {
    render(<ChatTurns turns={[{ role: "assistant", text: "Stopped", executionReceipt: { ...r, status: "blocked" }, completion }]} />);
    expect(screen.queryByRole("list", { name: "Settled transactions" })).toBeNull();
    expect(screen.getByText("Deposit 10 XLM")).toBeTruthy();
  });
  it("single transactions stay one bullet and greetings do not acquire receipts", () => {
    const single = { ...r, steps: [r.steps[0]] };
    render(<ChatTurns turns={[{ role: "assistant", text: "Completed", executionReceipt: single, completion: { ...completion, receiptKey: receiptKey(single) } },
      { role: "user", text: "Hi" }, { role: "assistant", text: "Hello!" }]} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText("Hello!")).toBeTruthy();
  });
});
