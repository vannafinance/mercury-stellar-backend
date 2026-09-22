import { describe, expect, it } from "vitest";
import {
  extractTxHash,
  isDiagnosisMessage,
  classifyToastMessage,
  sanitizeSessionEvents,
  sanitizeAttachments,
  MAX_ATTACHMENTS,
} from "@/lib/assistant/packet";

describe("assistant diagnosis routing", () => {
  it("treats failure questions as diagnosis", () => {
    for (const q of [
      "why did my transaction fail",
      "my transaction didn't execute",
      "what happened, it didn't go through",
      "simulation failed when I tried to lend",
      "the wallet rejected it",
    ]) {
      expect(isDiagnosisMessage(q), q).toBe(true);
    }
  });

  it("treats a bare tx hash as diagnosis", () => {
    const hash = "a".repeat(64);
    expect(isDiagnosisMessage(hash)).toBe(true);
    expect(extractTxHash(`Tx: ${hash}`)).toBe(hash);
  });

  it("does not swallow a live health question", () => {
    expect(isDiagnosisMessage("what's my health factor?")).toBe(false);
    expect(isDiagnosisMessage("how much do I owe?")).toBe(false);
  });
});

describe("assistant packet sanitizers", () => {
  it("classifies wallet cancel separately from a chain failure", () => {
    expect(classifyToastMessage("Transaction cancelled by user.")).toBe("wallet_rejected");
    expect(classifyToastMessage("Signing was cancelled.")).toBe("wallet_rejected");
    expect(classifyToastMessage("Cancelled — transaction was not submitted.")).toBe(
      "wallet_rejected",
    );
    expect(classifyToastMessage("On-chain contract rejected the transaction (error #3).")).toBe(
      "horizon_failed",
    );
    expect(classifyToastMessage("Transaction failed on-chain (txFailed).")).toBe("horizon_failed");
    expect(classifyToastMessage("simulation failed: balance too low")).toBe("simulation_failed");
  });

  it("marks a submitted-but-unconfirmed tx as its own stage", () => {
    const hash = "b".repeat(64);
    expect(
      classifyToastMessage(
        `Submitted, but the ledger had not confirmed it after 60s. Check ${hash} before retrying.`,
      ),
    ).toBe("submitted_unconfirmed");
  });

  it("keeps only five well-formed events", () => {
    const events = sanitizeSessionEvents([
      { kind: "nope", message: "x" },
      { kind: "toast_error", message: "  boom  ", at: 1 },
      { kind: "wallet_rejected", message: "cancelled", at: 2, tx_hash: "zz" },
      ...Array.from({ length: 8 }, (_, i) => ({
        kind: "toast_error",
        message: `e${i}`,
        at: i,
      })),
    ]);
    expect(events.length).toBeLessThanOrEqual(5);
    expect(events[0]?.kind).toBe("toast_error");
    expect(events[0]?.message).toBe("boom");
  });

  it("drops oversized or wrong-typed images", () => {
    const ok = sanitizeAttachments([
      { mime: "image/png", data: "aaa", source: "paste" },
      { mime: "image/gif", data: "bbb", source: "paste" },
      { mime: "image/jpeg", data: "ccc", source: "region" },
      { mime: "image/webp", data: "ddd", source: "drop" },
    ]);
    expect(ok).toHaveLength(MAX_ATTACHMENTS);
    expect(ok.map((a) => a.mime)).toEqual(["image/png", "image/jpeg"]);
  });
});
