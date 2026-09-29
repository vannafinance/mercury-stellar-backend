// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatTurns } from "@/components/copilot/chat-message";
import type { ThreadTurn } from "@/lib/copilot/investigation/thread";

/**
 * Live, 21 Sep, Freighter, auto-approve on: a turn's execution card read
 * "Nothing is sent without your signature." while a leg directly below it had already settled by
 * auto-dispatch, and a toast on the same screen read "Auto-dispatch on — transactions
 * will open directly in Freighter". Three signals about the same run, disagreeing.
 *
 * The label was not wrong about the run — it was wrong unconditionally. No caller of
 * `ExecutionStepper` ever passed `autoApprove`, so it defaulted to `false` and read
 * "Nothing is sent without your signature." for every session, Privy or Freighter, armed or not. This
 * pins `ChatTurns` — the component that actually rendered the card in the screenshot,
 * via a stored turn's `executionReceipt` — threading `sessionSigning` all the way down
 * to the label that names it.
 */

const receipt: ThreadTurn["executionReceipt"] = {
  workflowId: "wf-1",
  status: "running",
  network: "testnet",
  steps: [
    { operation: "supply_blend", asset: "BLUSDC", amount: "19.998", status: "settled", txHash: "1314989d".padEnd(64, "0"), settledLedger: 99 },
  ],
};

const turns: ThreadTurn[] = [
  { role: "user", text: "deposit 100 XLM, borrow 20 BLUSDC and supply it to blend" },
  { role: "assistant", text: "Paused for signature — finish signing to continue.", executionReceipt: receipt },
];

describe("ChatTurns — the execution card's label reflects the real signing state", () => {
  it("says Autonomous when the session is armed to sign without a click", () => {
    render(<ChatTurns turns={turns} sessionSigning={true} />);
    expect(screen.getByText("Signed within your auto-approve limits.")).toBeTruthy();
    expect(screen.queryByText("Nothing is sent without your signature.")).toBeNull();
  });

  it("says Step-by-Step Approval when it genuinely is not armed", () => {
    render(<ChatTurns turns={turns} sessionSigning={false} />);
    expect(screen.getByText("Nothing is sent without your signature.")).toBeTruthy();
    expect(screen.queryByText("Signed within your auto-approve limits.")).toBeNull();
  });

  it("defaults to Step-by-Step Approval rather than silently claiming autonomy", () => {
    // No sessionSigning passed at all — the safe default is the honest one.
    render(<ChatTurns turns={turns} />);
    expect(screen.getByText("Nothing is sent without your signature.")).toBeTruthy();
  });

  it("renders Vanna icon on the left of assistant replies", () => {
    render(<ChatTurns turns={turns} />);
    const icons = screen.getAllByAltText("Vanna");
    expect(icons.length).toBeGreaterThanOrEqual(1);
    expect(icons[0].getAttribute("src")).toBe("/logos/vanna-icon.png");
  });
});
