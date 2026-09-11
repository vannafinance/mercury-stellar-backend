import { describe, expect, it } from "vitest";
import { autoSignAllowed, controlFor, gradeForOp } from "@/lib/copilot/guardrail-policy";

describe("graded guardrail policy", () => {
  it("keeps reads open and irreversible ops on a human signature", () => {
    expect(gradeForOp("unknown_read")).toBe("manual_write");
    expect(gradeForOp("repay")).toBe("manual_write");
    expect(gradeForOp("close_account")).toBe("irreversible");
    expect(gradeForOp("settle")).toBe("irreversible");
    expect(gradeForOp("liquidate")).toBe("irreversible");
    expect(controlFor("read", false)).toBe("none");
    expect(controlFor("manual_write", false)).toBe("wallet");
    expect(controlFor("manual_write", true)).toBe("binding_and_caps");
    expect(controlFor("irreversible", true)).toBe("human_signature");
  });

  it("never allows session-sign for irreversible ops", () => {
    expect(autoSignAllowed("repay")).toBe(true);
    expect(autoSignAllowed("close_account")).toBe(false);
    expect(gradeForOp("settle_account")).toBe("irreversible");
    expect(autoSignAllowed("settle_account")).toBe(false);
    expect(autoSignAllowed("liquidate")).toBe(false);
  });
});
