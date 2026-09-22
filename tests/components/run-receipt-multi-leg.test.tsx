// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { writeFileSync } from "node:fs";
import { ChatTurns } from "@/components/copilot/chat-message";
import { buildRunReceipt, type RunReceiptLeg } from "@/components/copilot/run-receipt";
import type { ThreadTurn } from "@/lib/copilot/investigation/thread";

/**
 * Live, 22 Sep, wallet GDW3B2…VJ52: "deposit 100 XLM, borrow 20 BLUSDC and supply it to
 * blend" settled all three legs on-chain, and the finished EXECUTION PROGRESS card showed
 * exactly one — deposit_collateral — while the turn beside it said the run was done.
 *
 * The receipt's steps were built from the single write that had just been signed, so each
 * settling leg overwrote the last with a fresh one-element array. The last writer won and
 * the card was left describing one leg of three.
 */
const RUN: RunReceiptLeg[] = [
  { op: "deposit_collateral", asset: "XLM", amount: 100, status: "ok", tx_hash: "851d68f0".padEnd(64, "a") },
  { op: "borrow", asset: "BLUSDC", amount: 20, status: "ok", tx_hash: "4934cebd".padEnd(64, "b") },
  { op: "supply_blend", asset: "BLUSDC", amount: 19.998, status: "ok", tx_hash: "1314989d".padEnd(64, "c") },
];

const base = {
  isRun: true,
  runId: "run-851d68f0",
  requestId: "req-leg-3",
  network: "testnet",
  single: { op: "supply_blend", asset: "BLUSDC", amount: 19.998 },
  txHash: "1314989d".padEnd(64, "c"),
};

describe("a run's receipt describes the run, not the last leg to settle", () => {
  it("carries every leg, not just the one that finished last", () => {
    const receipt = buildRunReceipt({ ...base, legs: RUN });
    expect(receipt.steps).toHaveLength(3);
    expect(receipt.steps.map((s) => s.operation)).toEqual([
      "deposit_collateral",
      "borrow",
      "supply_blend",
    ]);
    // Each leg keeps its OWN hash. The old builder stamped the current tx on the one step.
    expect(new Set(receipt.steps.map((s) => s.txHash)).size).toBe(3);
  });

  it("keys on the run, so a later leg updates the same receipt instead of a new one", () => {
    const afterLeg1 = buildRunReceipt({ ...base, legs: RUN.slice(0, 1), requestId: "req-leg-1" });
    const afterLeg3 = buildRunReceipt({ ...base, legs: RUN, requestId: "req-leg-3" });
    // Different requests, same run — the receipt must not fork.
    expect(afterLeg1.workflowId).toBe(afterLeg3.workflowId);
  });

  it("still describes a single write as one step when there is no run", () => {
    const receipt = buildRunReceipt({ ...base, legs: [], isRun: false, runId: null });
    expect(receipt.steps).toHaveLength(1);
    expect(receipt.workflowId).toBe("req-leg-3");
  });

  it("reports a failed leg as failed rather than quietly settling it", () => {
    const withFailure: RunReceiptLeg[] = [
      RUN[0],
      { op: "borrow", asset: "BLUSDC", amount: 20, status: "error", tx_hash: null },
      { op: "supply_blend", asset: "BLUSDC", amount: 19.998, status: "pending", tx_hash: null },
    ];
    const receipt = buildRunReceipt({ ...base, legs: withFailure });
    expect(receipt.steps.map((s) => s.status)).toEqual(["settled", "failed", "pending"]);
  });

  it("renders all three legs in the card the user actually sees", () => {
    const receipt = buildRunReceipt({ ...base, legs: RUN });
    const turns: ThreadTurn[] = [
      { role: "user", text: "deposit 100 XLM, borrow 20 BLUSDC and supply it to blend" },
      { role: "assistant", text: "Supply 19.998 BLUSDC to Blend — settled on-chain.", executionReceipt: receipt },
    ];
    const { container } = render(<ChatTurns turns={turns} sessionSigning={true} />);
    const text = (container.textContent || "").replace(/\s+/g, " ");
    for (const needle of ["deposit_collateral", "borrow", "supply_blend", "100", "20", "19.998"]) {
      expect(text).toContain(needle);
    }
    writeFileSync(
      "tests/components/.rendered-card.txt",
      (container.textContent || "")
        .replace(/\s*\n\s*/g, "\n")
        .split("\n").map((l) => l.trim()).filter(Boolean).join("\n"),
    );
  });
});
