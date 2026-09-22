import { describe, expect, it } from "vitest";
import { investigationAnswerDocument } from "@/lib/copilot/investigation/answer-document";
import type { ResearchView } from "@/lib/copilot/investigation/view";

function result(facts: ResearchView["facts"], over: Partial<ResearchView> = {}): ResearchView {
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
    ...over,
  };
}

const DUMP: ResearchView["facts"] = [
  {
    id: "bal", label: "XLM wallet balance", value: "7752.2887205", unit: "XLM",
    venue: "wallet", evidenceId: "e1", sourcePath: "assets[0].balance", readAt: 1,
  },
  {
    id: "liq", label: "SOUSDC Earn total liquidity", value: "185447.70", unit: "SOUSDC",
    venue: "earn", evidenceId: "e2", sourcePath: "reserves[0].total_liquidity_human", readAt: 1,
  },
  {
    id: "apr", label: "SOUSDC Earn supply APR", value: "0.11", unit: "% APR",
    venue: "earn", evidenceId: "e2", sourcePath: "reserves[0].supply_apr_pct", readAt: 1,
  },
  {
    id: "apy", label: "BLUSDC Blend supply APY", value: "1.13", unit: "% APR",
    venue: "blend", evidenceId: "e3", sourcePath: "supply_apy_pct", readAt: 1,
  },
];

describe("investigationAnswerDocument", () => {
  it("keeps the headline and never publishes the research bag as a facts card", () => {
    const answer = investigationAnswerDocument(result(DUMP));
    expect(answer.headline).toBe("The checked figures are below.");
    expect(answer.facts).toEqual([]);
    expect(answer.venue).toBeUndefined();
  });

  it("does not replay market diagnostics from a stored history turn", () => {
    const answer = investigationAnswerDocument(result(DUMP, {
      originalRequest: "can you deposit xlm,usdc,blusdc 100 into the lending",
      message: "Lend 100 XLM to Earn, then Lend 100 BLUSDC to Earn. Approve to run these steps.",
    }));
    expect(answer.headline).toMatch(/Lend 100 XLM/);
    expect(answer.facts).toEqual([]);
  });

  it("does not dump facts when the investigation could not finish", () => {
    const answer = investigationAnswerDocument(result(DUMP, {
      status: "incomplete",
      message: "The investigation could not be completed from the reads it made. Nothing was executed — please try again.",
    }));
    expect(answer.headline).toMatch(/could not be completed/);
    expect(answer.facts).toEqual([]);
  });
});
