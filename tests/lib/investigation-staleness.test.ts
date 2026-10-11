import { describe, expect, it } from "vitest";
import { isInvestigationStale } from "@/components/copilot/investigation-staleness";

const base = { hasResult: true, loading: false, hasError: false, hasWorkflow: false, workflowLoading: false, signing: false,
  lastUserTurn: "How much more USDC can I borrow?", prompt: "Price of XLM" };

describe("isInvestigationStale", () => {
  it("hides the answer to an earlier question under a new prompt", () => {
    expect(isInvestigationStale(base)).toBe(true);
  });
  it("never hides an error from the newest turn behind the earlier answer", () => {
    expect(isInvestigationStale({ ...base, hasError: true })).toBe(false);
  });
  it("is not stale while a reply is loading, a run is live, or the prompts match", () => {
    expect(isInvestigationStale({ ...base, loading: true })).toBe(false);
    expect(isInvestigationStale({ ...base, hasWorkflow: true })).toBe(false);
    expect(isInvestigationStale({ ...base, signing: true })).toBe(false);
    expect(isInvestigationStale({ ...base, prompt: base.lastUserTurn })).toBe(false);
  });
  it("is not stale without a result", () => {
    expect(isInvestigationStale({ ...base, hasResult: false })).toBe(false);
  });
});
