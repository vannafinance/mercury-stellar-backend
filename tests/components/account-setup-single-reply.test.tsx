// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatTurns } from "@/components/copilot/chat-message";
import { receiptKey } from "@/lib/copilot/workflow-completion";
import type { ExecutionReceiptSnapshot } from "@/lib/copilot/execution-receipt";
import type { ThreadTurn } from "@/lib/copilot/investigation/thread";

afterEach(cleanup);

const setupHash = "d".repeat(64);
const depositHash = "e".repeat(64);
const setup: ExecutionReceiptSnapshot = {
  origin: "wallet", workflowId: "req-open", status: "completed", network: "testnet",
  steps: [{ operation: "create_account", label: "Open margin account", asset: "", amount: "", status: "settled", txHash: setupHash }],
};
const deposit: ExecutionReceiptSnapshot = {
  workflowId: "run-dep", status: "completed", network: "testnet",
  steps: [{ operation: "deposit_collateral", label: "Deposit 5 XLM as collateral", asset: "XLM", amount: "5", status: "settled", txHash: depositHash, settledLedger: 5309497 }],
};
const done = { workflowId: deposit.workflowId, receiptKey: receiptKey(deposit), generatedAt: 1, source: "model" as const };

const opened: ThreadTurn = { role: "assistant", text: "Your margin account is open. Continuing your original request; that action has not executed yet.", executionReceipt: setup };
const finished: ThreadTurn = { role: "assistant", text: "Done. Deposited 5 XLM as collateral.", executionReceipt: deposit, completion: done };

describe("an account opened for a request is one reply with that request", () => {
  it("draws one reply with the account transaction first and the deposit after it", () => {
    render(<ChatTurns turns={[{ role: "user", text: "Deposit 5 XLM" }, opened, finished]} />);
    expect(screen.getAllByAltText("Vanna")).toHaveLength(1);
    expect(screen.queryByText(/has not executed yet/)).toBeNull();
    const list = screen.getByRole("list", { name: "Settled transactions" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Your margin account is open");
    expect(items[1].textContent).toContain("Deposit 5 XLM as collateral");
    // Rows read as on Solana: what was done and its explorer link, no ledger number (owner, 22 Oct).
    expect(within(items[1]).getByRole("link").getAttribute("href")).toContain(depositHash);
    expect(items[1].textContent).not.toContain("Ledger");
    expect(screen.getAllByText("Deposit 5 XLM")).toHaveLength(1);
  });

  it("keeps the account-open reply as it is while the request is still continuing", () => {
    render(<ChatTurns turns={[{ role: "user", text: "Deposit 5 XLM" }, opened]} />);
    expect(screen.getByText(/Continuing your original request/)).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Settled transactions" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("leaves an account opened on its own, and a later separate message, untouched", () => {
    render(<ChatTurns turns={[{ role: "user", text: "open an account" }, opened, { role: "user", text: "Deposit 5 XLM" }, finished]} />);
    expect(screen.getAllByAltText("Vanna")).toHaveLength(2);
    expect(screen.getByText(/Continuing your original request/)).toBeTruthy();
  });
});
