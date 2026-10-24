// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InvestigationCard } from "@/components/copilot/investigation-card";
import type { ResearchView } from "@/lib/copilot/investigation/view";

/**
 * 24 Oct, live: a run that ran out of time said "please try again" and offered nothing to press - the user had to
 * retype the prompt. A run that stopped on the clock gets a button that asks the same thing again; a cancelled one
 * does not (a cancel is the user's own act, not a failure), and nothing else carries it.
 */
const incomplete = (stopReason?: string): ResearchView => ({
  status: "incomplete", message: "The investigation ran out of time before it could finish. Nothing was executed - please try again.",
  originalRequest: "Show the supply APY for all four pools", refinements: [],
  understanding: { intent: "answer", objective: "Rates", constraints: [], borrowing: "unspecified" },
  question: null, facts: [], capacity: null, candidates: null, rateComparisons: [], checks: [], warnings: [],
  scope: { wallet: "G", smartAccount: "C", network: "testnet" }, continuation: "sealed", executionAllowed: false,
  ...(stopReason ? { diagnostics: { stopReason } } : {}),
});
const card = (result: ResearchView | null, extra: Partial<Parameters<typeof InvestigationCard>[0]> = {}) =>
  render(<InvestigationCard prompt="Show the supply APY for all four pools" result={result} progress={null} loading={false} error={null} {...extra} />);

afterEach(cleanup);

describe("Try again", () => {
  it("appears on a run that stopped on the clock and asks the same thing again", () => {
    const retry = vi.fn();
    card(incomplete("deadline"), { onRetry: retry });
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it("appears on any other stop that is not a cancel", () => {
    card(incomplete("tool_budget"), { onRetry: () => {} });
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });
  it("is not offered after a cancel", () => {
    card(incomplete("cancelled"), { onRetry: () => {} });
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });
  it("is not offered on a result that completed", () => {
    card({ ...incomplete(), status: "researched" }, { onRetry: () => {} });
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });
  it("is not there while a run is in flight, and not without a handler", () => {
    card(incomplete("deadline"), { onRetry: () => {}, loading: true });
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    cleanup();
    card(incomplete("deadline"));
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });
});
