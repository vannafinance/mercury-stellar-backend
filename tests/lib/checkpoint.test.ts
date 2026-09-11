import { describe, expect, it } from "vitest";
import { checkpointFromJournal } from "@/lib/copilot/checkpoint";

describe("checkpointFromJournal", () => {
  it("records settled legs and the last hash without depending on in-memory runtime state", () => {
    const checkpoint = checkpointFromJournal({
      workflowId: "wf-1",
      subject: "did:privy:alice",
      status: "running",
      digest: "abc",
      now: 1_700_000_000_000,
      steps: [
        { id: "s1", status: "settled", txHash: "aa".repeat(32) },
        { id: "s2", status: "invoking" },
        { id: "s3", status: "pending" },
      ],
    });
    expect(checkpoint).toMatchObject({
      workflowId: "wf-1",
      subject: "did:privy:alice",
      status: "running",
      digest: "abc",
      settledStepIds: ["s1"],
      currentStepId: "s2",
      lastTxHash: "aa".repeat(32),
      updatedAt: 1_700_000_000_000,
    });
  });

  it("has no current step once every leg has settled or failed", () => {
    const checkpoint = checkpointFromJournal({
      workflowId: "wf-2",
      subject: "owner",
      status: "completed",
      digest: "def",
      steps: [
        { id: "s1", status: "settled", txHash: "bb".repeat(32) },
        { id: "s2", status: "failed" },
      ],
    });
    expect(checkpoint.currentStepId).toBeNull();
    expect(checkpoint.settledStepIds).toEqual(["s1"]);
    expect(checkpoint.lastTxHash).toBe("bb".repeat(32));
  });
});
