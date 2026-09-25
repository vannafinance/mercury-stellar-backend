// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ClarifyQuestionnaire } from "@/components/copilot/clarify-questionnaire";
import { ThemeProvider } from "@/contexts/theme-context";
import { answerProblem, buildQuestionnaire, buildQuestionnaireSet } from "@/lib/copilot/investigation/questionnaire";
import type { Observation, StatedAction } from "@/lib/copilot/investigation/types";
import type { Questionnaire, QuestionnaireAnswers } from "@/lib/copilot/investigation/view";

/**
 * What the component SENDS must be what the server ACCEPTS. 25 Sep, live: "lend 20 blusdc and
 * deposit xlm" was answered and refused as invalid_answers before any work, with nothing on
 * screen, because the component answered a one-section questionnaire in the single form. Each
 * case builds the questionnaire the server would issue, fills it in through the real component,
 * and hands the submitted answers to the server's own check.
 */
const NOW = 1_700_000_000_000;
const obs = (id: string, capability: string, data: Record<string, unknown>, args: Record<string, unknown> = {}): Observation =>
  ({ id, capability, args, observedAt: NOW, status: "ok", data });
const rows: Observation[] = [
  obs("w", "wallet_balances", { assets: [
    { symbol: "XLM", balance: "7652.2680713", decimals: 7, status: "ok" },
    { symbol: "BLUSDC", balance: "598", decimals: 7, status: "ok" },
    { symbol: "AQUSDC", balance: "4956.541537", decimals: 7, status: "ok" },
  ], fee_reserve_xlm: "0" }),
  obs("a", "account_collateral", { collateral: [{ symbol: "XLM", balance: "8693" }] }),
  ...["XLM", "BLUSDC", "AQUSDC"].map((asset) => obs(`p-${asset}`, "asset_price", { price_usd: asset === "XLM" ? "0.2" : "1" }, { asset })),
  ...["BLUSDC", "AQUSDC"].map((asset) => obs(`e-${asset}`, "earn_market", { supply_apr_pct: "5" }, { asset })),
  obs("b", "blend_markets", { reserves: [{ symbol: "XLM", supply_apr_pct: "12" }, { symbol: "USDC", supply_apr_pct: "8" }] }),
];

function submitThroughComponent(questionnaire: Questionnaire, pick: () => void): QuestionnaireAnswers {
  const onSubmit = vi.fn();
  render(
    <ThemeProvider>
      <ClarifyQuestionnaire questionnaire={questionnaire} onSubmit={onSubmit} onCancel={vi.fn()} onSomethingElse={vi.fn()} />
    </ThemeProvider>,
  );
  pick();
  fireEvent.click(screen.getByTestId("btn-send"));
  expect(onSubmit).toHaveBeenCalledOnce();
  return onSubmit.mock.calls[0][0] as QuestionnaireAnswers;
}

describe("the component's answers pass the server's check", () => {
  it("one section plus a stated action: lend 20 blusdc and deposit xlm", () => {
    const message = "lend 20 blusdc and deposit xlm";
    const stated: StatedAction[] = [
      { op: "lend", asset: "BLUSDC", sizing: { kind: "literal", amount: "20", sourceQuote: "lend 20 blusdc" }, sourceQuote: "lend 20 blusdc" },
    ];
    const issued = buildQuestionnaireSet(
      [{ op: "deposit_collateral", asset: "XLM", slots: ["amount"], sourceQuote: "deposit xlm" }],
      rows, NOW, [message], stated,
    )!;
    expect(issued.sections).toHaveLength(1);
    const answers = submitThroughComponent(issued, () => {
      fireEvent.change(screen.getByPlaceholderText("0.0 or 50%"), { target: { value: "15" } });
    });
    expect(answers.sections?.[0]).toMatchObject({ asset: "XLM", amount: { kind: "literal", amount: "15" } });
    expect(answerProblem(issued, answers)).toBeNull();
  });

  it("a single questionnaire with a preset: supply my usdc", () => {
    const issued = buildQuestionnaire({ asset: "USDC", slots: ["asset", "venue", "amount"] }, rows, NOW)!;
    const answers = submitThroughComponent(issued, () => {
      fireEvent.click(screen.getByText("BLUSDC"));
      fireEvent.click(screen.getAllByText("Earn")[0]);
      fireEvent.click(screen.getByTestId("preset-0.25"));
    });
    expect(answers.amount).toEqual({ kind: "literal", amount: "149.5" });
    expect(answerProblem(issued, answers)).toBeNull();
  });
});
