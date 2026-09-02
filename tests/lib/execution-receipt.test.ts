import { describe, expect, it } from "vitest";
import { localExecutionAnswer } from "@/lib/copilot/execution-receipt";

describe("localExecutionAnswer", () => {
  it("paints an instant all-settled receipt from the legs", () => {
    const answer = localExecutionAnswer({
      intent: "swap 10 XLM to SOUSDC then add liquidity",
      legs: [
        { label: "Swap 10 XLM → SOUSDC", status: "ok", tx_hash: "aa".repeat(32) },
        { label: "Add liquidity SOUSDC", status: "ok", tx_hash: "bb".repeat(32) },
      ],
      hf: 1.5,
      floor: 2,
    });
    expect(answer.headline).toMatch(/completed on-chain|liquidity/i);
    expect(answer.facts.find((f) => f.label === "steps settled")?.value).toBe("2 of 2");
    expect(answer.facts.find((f) => f.label === "transactions")?.value).toBe("2");
    expect(answer.facts.find((f) => f.label === "health factor")?.value).toBe("1.50");
    expect(answer.facts.find((f) => f.label === "health factor")?.tone).toBe("warn");
  });

  it("describes an HF pause without claiming the tail ran", () => {
    const answer = localExecutionAnswer({
      intent: "deposit 50 XLM then borrow keeping HF above 2",
      legs: [
        { label: "Deposit 50 XLM", status: "ok", tx_hash: "cc".repeat(32) },
        { label: "Borrow BLUSDC", status: "pending" },
      ],
      hf: 1.5,
      floor: 2,
      pausedHf: true,
    });
    expect(answer.headline).toMatch(/Paused/i);
    expect(answer.facts.find((f) => f.label === "steps settled")?.value).toBe("1 of 2");
    expect(answer.note).toMatch(/Continue/i);
  });
});
