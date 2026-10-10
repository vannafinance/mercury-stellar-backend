import { describe, expect, it } from "vitest";
import { buildQuestionnaire, buildQuestionnaireSet, readsForQuestionnaire, answerProblem, actionsFromAnswers } from "@/lib/copilot/investigation/questionnaire";
import { OP_FLOW, type WorkflowOp } from "@/lib/copilot/workflow/types";
import type { Observation } from "@/lib/copilot/investigation/types";

const now = 1_700_000_000_000;
const observations: Observation[] = [{
  id: "existing-debt", capability: "account_debt", args: {}, observedAt: now, status: "ok",
  data: { debt: [{ symbol: "XLM", balance: "7684" }] },
}];

describe("credit is not a holding the user can spend", () => {
  it("asks only for the asset and seals maximum sizing through Send", () => {
    const issued = buildQuestionnaireSet({ op: "borrow", slots: ["asset"], sizing: "to_floor", sourceQuote: "borrow as much as possible" } as any, observations, now, ["borrow as much as possible"]);
    expect(issued).not.toBeNull();
    const section = issued!.sections![0];
    expect(section.steps.map(step => step.slot)).toEqual(["asset"]);
    const answers = { questionnaireId: issued!.id, asset: "XLM", venue: null, amount: { kind: "to_floor" as const }, summary: "Borrow the maximum XLM", sections: [{ sectionId: section.id, asset: "XLM", venue: null, amount: { kind: "to_floor" as const } }] };
    expect(answerProblem(issued!, answers as any)).toBeNull();
    expect(actionsFromAnswers(issued!, answers as any)[0]).toMatchObject({ op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } });
    expect(answerProblem(issued!, { ...answers, sections: [{ ...answers.sections[0], amount: { kind: "literal", amount: "7684" } }] } as any)).not.toBeNull();
  });
  for (const op of Object.keys(OP_FLOW) as WorkflowOp[]) {
    if (OP_FLOW[op].from !== "debt") continue;
    it(`keeps ${op} as a plain clarification rather than sizing from existing debt`, () => {
      const missing = { op, asset: "XLM", slots: ["amount" as const] };
      expect(buildQuestionnaire(missing, observations, now)).toBeNull();
      expect(readsForQuestionnaire(missing, observations, now)).toEqual([]);
      expect(buildQuestionnaireSet([missing, { op: "lend", asset: "XLM", slots: ["amount"] }], observations, now)).toBeNull();
    });
  }
});
