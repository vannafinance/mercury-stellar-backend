// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ClarifyQuestionnaire } from "@/components/copilot/clarify-questionnaire";
import { ThemeProvider } from "@/contexts/theme-context";
import { answerProblem, buildQuestionnaireSet } from "@/lib/copilot/investigation/questionnaire";
import type { Observation } from "@/lib/copilot/investigation/types";
import type { QuestionnaireAnswers } from "@/lib/copilot/investigation/view";

const NOW = 1_700_000_000_000;
const obs = (id: string, capability: string, data: Record<string, unknown>, args: Record<string, unknown> = {}): Observation =>
  ({ id, capability, args, observedAt: NOW, status: "ok", data });
const pool = { found: true, pool: { reserves: { XLM: "100000", SOUSDC: "22000" }, total_share: "40000", fee: "0.003" } };
const rows: Observation[] = [
  obs("w", "wallet_balances", { assets: [
    { symbol: "XLM", balance: "7652.2680713", decimals: 7, status: "ok" },
    { symbol: "BLUSDC", balance: "598", decimals: 7, status: "ok" },
    { symbol: "AQUSDC", balance: "4956.541537", decimals: 7, status: "ok" },
    { symbol: "SOUSDC", balance: "2705.3817198", decimals: 7, status: "ok" },
  ], fee_reserve_xlm: "0" }),
  obs("a", "account_collateral", { collateral: [{ symbol: "XLM", balance: "7233.8463561" }, { symbol: "SOUSDC", balance: "0.3163653" }] }),
  ...["XLM", "BLUSDC", "AQUSDC", "SOUSDC"].map((asset) => obs(`p-${asset}`, "asset_price", { price_usd: asset === "XLM" ? "0.22" : "1" }, { asset })),
  ...["BLUSDC", "AQUSDC", "SOUSDC"].map((asset) => obs(`e-${asset}`, "earn_market", { supply_apr_pct: "5" }, { asset })),
  obs("b", "blend_markets", { reserves: [{ symbol: "USDC", supply_apr_pct: "1.67" }] }),
  obs("s", "soroswap_pool_reserves", pool, { asset: "SOUSDC" }),
];

describe("supply my usdc answered with an LP pool", () => {
  it("passes the server check", () => {
    const issued = buildQuestionnaireSet([{ asset: "USDC", slots: ["asset", "venue", "amount"], sourceQuote: "supply my usdc" }], rows, NOW, ["supply my usdc"])!;
    const onSubmit = vi.fn();
    render(<ThemeProvider><ClarifyQuestionnaire questionnaire={issued} onSubmit={onSubmit} onCancel={vi.fn()} onSomethingElse={vi.fn()} /></ThemeProvider>);
    fireEvent.click(screen.getByText("SOUSDC"));
    const lp = screen.getAllByText(/Soroswap/)[0];
    fireEvent.click(lp);
    fireEvent.change(screen.getByPlaceholderText("0.0 or 50%"), { target: { value: "100" } });
    fireEvent.click(screen.getByTestId("btn-send"));
    const answers = onSubmit.mock.calls[0][0] as QuestionnaireAnswers;

    expect(answerProblem(issued, answers)).toBeNull();
    // The wallet top-up covers the rest, but not past account + wallet.
    const section = answers.sections![0];
    const over = { ...answers, sections: [{ ...section, amount: { kind: "literal" as const, amount: "2705.7" } }] };
    expect(answerProblem(issued, over)).toMatch(/more than the 2705.6980851 SOUSDC/);
  });
});
