// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatTurns } from "@/components/copilot/chat-message";
import { VANNA_ICON_SRC } from "@/components/copilot/vanna-icon-data";
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

describe("ChatTurns — the execution card makes no signing claim of its own", () => {
  // The footer line that used to name the signing state ("Nothing is sent without your signature."
  // / "Signed within your auto-approve limits.") was removed by design: the header, the wallet mark
  // and the Sign button already say who acts next. What must never come back is the 21 Sep bug,
  // where that line contradicted the run beneath it. With no line, there is nothing to contradict.
  it.each([
    ["armed", true],
    ["not armed", false],
    ["unspecified", undefined],
  ])("shows neither signing claim when the session is %s", (_name, sessionSigning) => {
    render(<ChatTurns turns={turns} sessionSigning={sessionSigning} />);
    expect(screen.queryByText("Signed within your auto-approve limits.")).toBeNull();
    expect(screen.queryByText("Nothing is sent without your signature.")).toBeNull();
    expect(screen.getByLabelText("Settled")).toBeTruthy();
  });

  // One user turn and one assistant turn: the mark belongs to the reply only, never to the prompt.
  // It is inlined (no request), because a fetched avatar sat in the browser queue behind slow API
  // calls and a finished answer rendered without it.
  it("renders the inline Vanna icon on assistant replies only", () => {
    render(<ChatTurns turns={turns} />);
    const icons = screen.getAllByAltText("Vanna");
    expect(icons).toHaveLength(1);
    expect(icons[0].getAttribute("src")).toBe(VANNA_ICON_SRC);
    expect(VANNA_ICON_SRC.startsWith("data:image/png;base64,")).toBe(true);
    expect(icons[0].closest("[data-cp-user-bubble]")).toBeNull();
  });
});
