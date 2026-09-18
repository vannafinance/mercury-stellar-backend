import { describe, expect, it } from "vitest";
import { investigationAnswerDocument } from "@/lib/copilot/investigation/answer-document";
import type { ResearchView } from "@/lib/copilot/investigation/view";

function result(facts: ResearchView["facts"]): ResearchView {
  return {
    status: "researched",
    message: "The checked figures are below.",
    originalRequest: "show my position",
    refinements: [],
    understanding: null,
    question: null,
    facts,
    checks: [],
    warnings: [],
    scope: { wallet: null, smartAccount: null, network: "testnet" },
    continuation: "sealed",
    executionAllowed: false,
  };
}

describe("investigationAnswerDocument", () => {
  it("carries the compatibility message and presents audited facts as typed values", () => {
    const answer = investigationAnswerDocument(result([
      {
        id: "health",
        label: "Current health factor",
        value: "3.898658825216954744",
        unit: "HF",
        venue: "margin",
        evidenceId: "e1",
        sourcePath: "health_factor",
        readAt: 1,
      },
      {
        id: "debt",
        label: "Reported debt",
        value: "278.9886",
        unit: "USD",
        venue: "margin",
        evidenceId: "e1",
        sourcePath: "debt_usd",
        readAt: 1,
      },
    ]));

    expect(answer.headline).toBe("The checked figures are below.");
    expect(answer.venue).toBe("margin");
    expect(answer.facts).toEqual([
      { label: "Current health factor", value: "3.90" },
      { label: "Reported debt", value: "$278.99" },
    ]);
  });

  it("does not claim one venue when facts span multiple providers", () => {
    const answer = investigationAnswerDocument(result([
      {
        id: "wallet", label: "XLM wallet balance", value: "12.5", unit: "XLM",
        venue: "wallet", evidenceId: "e1", sourcePath: "assets[0].balance", readAt: 1,
      },
      {
        id: "rate", label: "BLUSDC supply APR", value: "6.4", unit: "% APR",
        venue: "blend", evidenceId: "e2", sourcePath: "supply_apr_pct", readAt: 1,
      },
    ]));

    expect(answer.venue).toBeUndefined();
    expect(answer.facts).toEqual([
      { label: "XLM wallet balance", value: "12.5 XLM" },
      { label: "BLUSDC supply APR", value: "6.40% APR" },
    ]);
  });
});
