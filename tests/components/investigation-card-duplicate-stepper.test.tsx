// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { InvestigationCard } from "@/components/copilot/investigation-card";
import type { ThreadTurn } from "@/lib/copilot/investigation/thread";
import type { WorkflowView } from "@/lib/copilot/workflow/types";

/**
 * One run, drawn once.
 *
 * Live, 22 Sep: "I accept the quoted loss, can you swap 100 XLM to AQUSDC" showed the
 * swap's EXECUTION PROGRESS stepper twice on one screen — once in the conversation and
 * again inside this card, both settled, same transaction, one directly above the other.
 *
 * Neither component was wrong on its own. The workspace copies every `workflow.view`
 * onto the assistant turn as a durable receipt, `ChatTurns` renders that receipt, and
 * this card independently renders the same `workflow.steps` — so the moment the receipt
 * is written, two components paint the same steps from the same source.
 */

const WORKFLOW_ID = "wf-swap-100-xlm";

function workflow(over: Partial<WorkflowView> = {}): WorkflowView {
  return {
    id: WORKFLOW_ID,
    revision: 1,
    digest: "d",
    status: "completed",
    objective: "Swap 100 XLM to AQUSDC on margin account with accepted slippage loss.",
    expiresAt: 0,
    assumptions: [],
    constraints: [],
    slippageAccepted: true,
    message: "All approved transactions were confirmed on chain.",
    steps: [
      {
        id: "s1",
        op: "swap",
        asset: "XLM",
        amount: "100",
        label: "Swap 100 XLM for at least 1.1264769 AQUSDC on Aquarius",
        status: "settled",
        txHash: "f256a511abcdef",
      },
    ],
    ...over,
  } as WorkflowView;
}

/** The assistant turn the workspace has already stamped with this run's receipt. */
function turnsWithReceipt(workflowId: string): ThreadTurn[] {
  return [
    { role: "user", text: "I accept the quoted loss, can you swap 100 XLM to AQUSDC" },
    {
      role: "assistant",
      text: "Swap 100 XLM for at least 1.1264769 AQUSDC on Aquarius. Approve to run this step.",
      executionReceipt: {
        workflowId,
        status: "completed",
        network: "testnet",
        steps: [
          {
            operation: "swap",
            asset: "XLM",
            amount: "100",
            status: "settled",
            txHash: "f256a511abcdef",
          },
        ],
      },
    },
  ];
}

function renderCard(turns: ThreadTurn[]) {
  return render(
    <InvestigationCard
      prompt="I accept the quoted loss, can you swap 100 XLM to AQUSDC"
      result={null}
      progress={null}
      loading={false}
      error={null}
      turns={turns}
      omitTranscript
      workflow={workflow()}
    />,
  );
}

describe("THE LIVE BUG: one settled swap, two execution steppers", () => {
  it("does not draw the stepper when the thread already carries this run's receipt", () => {
    renderCard(turnsWithReceipt(WORKFLOW_ID));
    expect(screen.queryByRole("region", { name: /execution progress/i })).toBeNull();
  });

  /**
   * Only the duplicated stepper goes. The heading, the objective and the run's own
   * message are this section's alone — dropping them would trade a double render for a
   * missing one.
   */
  it("keeps the rest of the section, so nothing is lost with the stepper", () => {
    renderCard(turnsWithReceipt(WORKFLOW_ID));
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText(/All approved transactions were confirmed on chain/i)).toBeTruthy();
  });

  it("still draws the stepper when no turn carries a receipt for it", () => {
    // The same thread before the workspace has written the receipt — nothing else is
    // painting these steps yet, so this section is the only place the run is visible.
    renderCard([
      { role: "user", text: "swap 100 XLM to AQUSDC" },
      { role: "assistant", text: "Swap 100 XLM for at least 1.1264769 AQUSDC on Aquarius." },
    ]);
    expect(screen.queryByRole("region", { name: /execution progress/i })).toBeTruthy();
  });

  /**
   * A receipt for a DIFFERENT run says nothing about this one — keyed by `workflowId`
   * precisely so an earlier run's receipt cannot blank the current run's progress.
   */
  it("still draws the stepper when the only receipt belongs to an earlier run", () => {
    renderCard(turnsWithReceipt("wf-some-earlier-run"));
    expect(screen.queryByRole("region", { name: /execution progress/i })).toBeTruthy();
  });
});
