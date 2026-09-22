import { describe, expect, it, vi } from "vitest";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import {
  anchoredLifecycleWrite,
  resolveLifecycleWrite,
} from "@/lib/copilot/workflow/lifecycle";
import { WORKFLOW_OPS } from "@/lib/copilot/workflow/types";

const base = {
  kind: "research_complete",
  goal: {
    intent: "strategy",
    objective: "open a margin account",
    constraints: [],
    borrowing: "unspecified",
    write: { op: "create_account", sourceQuote: "open a margin account" },
  },
  findings: [{ summary: "Opening a margin account for the connected wallet.", evidenceIds: [] }],
  openQuestions: [],
};

describe("lifecycle writes are not plan ops", () => {
  it("keeps create_account off the sized op table", () => {
    expect(WORKFLOW_OPS).not.toContain("create_account");
  });

  it("parses goal.write and only runs anchoredLifecycleWrite when the quote is in the user message", () => {
    const decision = parseDecision(base);
    expect(decision?.kind).toBe("research_complete");
    if (decision?.kind !== "research_complete") return;
    expect(decision.goal.write).toEqual({ op: "create_account", sourceQuote: "open a margin account" });
    expect(anchoredLifecycleWrite(decision.goal.write, ["open a margin account"], false)).toBe("create_account");
    expect(anchoredLifecycleWrite(decision.goal.write, ["lend 10 XLM"], false)).toBeNull();
    expect(anchoredLifecycleWrite(decision.goal.write, ["open a margin account"], true)).toBeNull();
  });
});

describe("resolveLifecycleWrite dual sources and veto", () => {
  it("resolves from deterministic router when modelWrite is absent", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const op = resolveLifecycleWrite({
        modelWrite: undefined,
        messages: ["open a margin account"],
        hasSizedWork: false,
      });
      expect(op).toBe("create_account");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("model lifecycle write rejected (absent)"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("resolves from deterministic router when model re-capitalises or punctuates the sourceQuote", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Model returned capitalised "Open a margin account." which fails exact includes on ["open a margin account"]
      const op = resolveLifecycleWrite({
        modelWrite: { op: "create_account", sourceQuote: "Open a margin account." },
        messages: ["open a margin account"],
        hasSizedWork: false,
      });
      expect(op).toBe("create_account");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("model lifecycle write rejected (quote-mismatched)"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("resolves directly from model when modelWrite is anchored and valid", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const op = resolveLifecycleWrite({
        modelWrite: { op: "create_account", sourceQuote: "open a margin account" },
        messages: ["open a margin account"],
        hasSizedWork: false,
      });
      expect(op).toBe("create_account");
      // Source 1 succeeded so source 2 warning was NOT triggered
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("vetoes immediately when hasSizedWork is true, regardless of model or router", () => {
    // Model wrote valid op
    expect(
      resolveLifecycleWrite({
        modelWrite: { op: "create_account", sourceQuote: "open a margin account" },
        messages: ["open a margin account"],
        hasSizedWork: true,
      }),
    ).toBeNull();

    // Model omitted op, router would match
    expect(
      resolveLifecycleWrite({
        modelWrite: undefined,
        messages: ["open a margin account"],
        hasSizedWork: true,
      }),
    ).toBeNull();
  });

  it("returns null when the message is not a lifecycle write", () => {
    const op = resolveLifecycleWrite({
      modelWrite: undefined,
      messages: ["what is the price of XLM?"],
      hasSizedWork: false,
    });
    expect(op).toBeNull();
  });

  it("generalises to alternative lifecycle phrasings (not tuned to open a margin account)", () => {
    // Other lifecycle phrases that route to create_account:
    const op1 = resolveLifecycleWrite({
      modelWrite: undefined,
      messages: ["open a smart account"],
      hasSizedWork: false,
    });
    expect(op1).toBe("create_account");

    const op2 = resolveLifecycleWrite({
      modelWrite: undefined,
      messages: ["create margin account"],
      hasSizedWork: false,
    });
    expect(op2).toBe("create_account");
  });
});
