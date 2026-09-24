// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  ClarifyQuestionnaire,
  buildQuestionnaireSummary,
} from "@/components/copilot/clarify-questionnaire";
import type { Questionnaire } from "@/lib/copilot/investigation/view";

const mockQuestionnaire: Questionnaire = {
  id: "q-test-1",
  title: "Supply USDC",
  subtitle: "Choose which, where and how much",
  steps: [
    {
      slot: "asset",
      prompt: "Which asset?",
      options: [
        { id: "blusdc", label: "BLUSDC", detail: "680 in wallet" },
        { id: "aqusdc", label: "AQUSDC", detail: "500 in wallet" },
      ],
    },
    {
      slot: "venue",
      prompt: "Where should it go?",
      options: [
        { id: "earn", label: "Earn", detail: "19.17% APY", forAsset: "blusdc", op: "lend" },
        { id: "blend", label: "Blend", detail: "8.5% APY", forAsset: "blusdc", op: "supply_blend" },
        {
          id: "pool_xlm_aqusdc",
          label: "Aquarius XLM/AQUSDC pool",
          detail: "pairs with XLM",
          forAsset: "aqusdc",
          op: "add_liquidity",
        },
      ],
    },
    {
      slot: "amount",
      prompt: "How much?",
      options: [],
      max: {
        blusdc: { amount: "680", asset: "BLUSDC", where: "wallet" },
        aqusdc: { amount: "500", asset: "AQUSDC", where: "wallet" },
        pool_xlm_aqusdc: { amount: "200", asset: "AQUSDC", where: "wallet" },
      },
      presets: [
        { id: "10", label: "10%", percent: "10" },
        { id: "25", label: "25%", percent: "25" },
        { id: "50", label: "50%", percent: "50" },
        { id: "100", label: "100% / max", percent: "100" },
      ],
      pair: {
        pool_xlm_aqusdc: { asset: "XLM", perUnit: "2.5" },
      },
    },
  ],
};

describe("ClarifyQuestionnaire Component", () => {
  it("renders title, subtitle, and step counter", () => {
    render(
      <ClarifyQuestionnaire
        questionnaire={mockQuestionnaire}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onSomethingElse={vi.fn()}
      />
    );

    expect(screen.getByText("Supply USDC")).toBeTruthy();
    expect(screen.getByText("Choose which, where and how much")).toBeTruthy();
    expect(screen.getByTestId("step-counter").textContent).toContain("1 of 3");
  });

  it("filters the venue step by the selected asset", () => {
    render(
      <ClarifyQuestionnaire
        questionnaire={mockQuestionnaire}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onSomethingElse={vi.fn()}
      />
    );

    // Pick BLUSDC
    const blusdcOption = screen.getByTestId("option-blusdc");
    fireEvent.click(blusdcOption);

    // Now on step 2 (Venue)
    expect(screen.getByTestId("step-counter").textContent).toContain("2 of 3");
    expect(screen.getByTestId("option-earn")).toBeTruthy();
    expect(screen.getByTestId("option-blend")).toBeTruthy();
    // AQUSDC pool option must NOT be present for BLUSDC
    expect(screen.queryByTestId("option-pool_xlm_aqusdc")).toBeNull();
  });

  it("skips single-option steps automatically (counted, not shown)", () => {
    render(
      <ClarifyQuestionnaire
        questionnaire={mockQuestionnaire}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onSomethingElse={vi.fn()}
      />
    );

    // Pick AQUSDC — its venue has only 1 option (pool_xlm_aqusdc)
    const aqusdcOption = screen.getByTestId("option-aqusdc");
    fireEvent.click(aqusdcOption);

    // The venue step had only 1 option, so it should be skipped and land on Amount step (3 of 3)
    expect(screen.getByTestId("step-counter").textContent).toContain("3 of 3");
    // Collapsed summary of skipped venue step must be rendered
    expect(screen.getByText(/Aquarius XLM\/AQUSDC pool/i)).toBeTruthy();
  });

  it("skips single-option asset step on mount", () => {
    const singleAssetQuestionnaire: Questionnaire = {
      id: "q-single-asset",
      title: "Supply XLM",
      subtitle: "Choose where and how much",
      steps: [
        {
          slot: "asset",
          prompt: "Which asset?",
          options: [{ id: "xlm", label: "XLM", detail: "1000 in wallet" }],
        },
        {
          slot: "venue",
          prompt: "Where should it go?",
          options: [
            { id: "blend", label: "Blend", detail: "5% APY" },
            { id: "earn", label: "Earn", detail: "10% APY" },
          ],
        },
        {
          slot: "amount",
          prompt: "How much?",
          options: [],
        },
      ],
    };

    render(
      <ClarifyQuestionnaire
        questionnaire={singleAssetQuestionnaire}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onSomethingElse={vi.fn()}
      />
    );

    // Initial step should be Venue (2 of 3) since Asset had 1 option and was auto-skipped
    expect(screen.getByTestId("step-counter").textContent).toContain("2 of 3");
    expect(screen.getByTestId("option-blend")).toBeTruthy();
    expect(screen.getByTestId("option-earn")).toBeTruthy();
    expect(screen.getByText(/Q1 Asset/i)).toBeTruthy();
  });

  it("max blocks an over-amount and keeps Send disabled", () => {
    render(
      <ClarifyQuestionnaire
        questionnaire={mockQuestionnaire}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onSomethingElse={vi.fn()}
      />
    );

    // Pick BLUSDC -> Earn -> Amount step
    fireEvent.click(screen.getByTestId("option-blusdc"));
    fireEvent.click(screen.getByTestId("option-earn"));

    // Check we are on Amount step
    expect(screen.getByTestId("step-counter").textContent).toContain("3 of 3");
    expect(screen.getByText(/You have/i).textContent).toContain("680 BLUSDC available");

    const input = screen.getByPlaceholderText(/0.0 or 50%/i);
    // Enter an amount exceeding max (680)
    fireEvent.change(input, { target: { value: "700" } });

    // Should display validation error
    const errorMsg = screen.getByTestId("amount-error");
    expect(errorMsg.textContent).toContain("Amount exceeds available 680 BLUSDC");

    // Send button must stay disabled
    const sendBtn = screen.getByTestId("btn-send");
    expect(sendBtn.hasAttribute("disabled")).toBe(true);
  });

  it("a percent converts and displays calculated amount", () => {
    render(
      <ClarifyQuestionnaire
        questionnaire={mockQuestionnaire}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onSomethingElse={vi.fn()}
      />
    );

    // Pick BLUSDC -> Earn
    fireEvent.click(screen.getByTestId("option-blusdc"));
    fireEvent.click(screen.getByTestId("option-earn"));

    // Click 50% preset
    const preset50 = screen.getByTestId("preset-50");
    fireEvent.click(preset50);

    // 50% of 680 = 340
    const preview = screen.getByTestId("percent-converted");
    expect(preview.textContent).toContain("340 BLUSDC");

    // Send button should be enabled
    const sendBtn = screen.getByTestId("btn-send");
    expect(sendBtn.hasAttribute("disabled")).toBe(false);
  });

  it("Send stays disabled until complete, then submits exact answers and summary", () => {
    const handleSubmit = vi.fn();
    render(
      <ClarifyQuestionnaire
        questionnaire={mockQuestionnaire}
        onSubmit={handleSubmit}
        onCancel={vi.fn()}
        onSomethingElse={vi.fn()}
      />
    );

    const sendBtn = screen.getByTestId("btn-send");
    // Initially disabled on step 1
    expect(sendBtn.hasAttribute("disabled")).toBe(true);

    // Select BLUSDC
    fireEvent.click(screen.getByTestId("option-blusdc"));
    expect(sendBtn.hasAttribute("disabled")).toBe(true);

    // Select Earn
    fireEvent.click(screen.getByTestId("option-earn"));
    expect(sendBtn.hasAttribute("disabled")).toBe(true);

    // Click 50% preset
    fireEvent.click(screen.getByTestId("preset-50"));
    expect(sendBtn.hasAttribute("disabled")).toBe(false);

    // Submit
    fireEvent.click(sendBtn);

    expect(handleSubmit).toHaveBeenCalledTimes(1);
    expect(handleSubmit).toHaveBeenCalledWith({
      questionnaireId: "q-test-1",
      asset: "blusdc",
      venue: "earn",
      amount: { kind: "fraction", percent: "50" },
      summary: "Supply 50% of my BLUSDC to Earn",
    });
  });

  it("submits literal amount answers and summary correctly", () => {
    const handleSubmit = vi.fn();
    render(
      <ClarifyQuestionnaire
        questionnaire={mockQuestionnaire}
        onSubmit={handleSubmit}
        onCancel={vi.fn()}
        onSomethingElse={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("option-blusdc"));
    fireEvent.click(screen.getByTestId("option-blend"));

    const input = screen.getByPlaceholderText(/0.0 or 50%/i);
    fireEvent.change(input, { target: { value: "100" } });

    const sendBtn = screen.getByTestId("btn-send");
    expect(sendBtn.hasAttribute("disabled")).toBe(false);

    fireEvent.click(sendBtn);

    expect(handleSubmit).toHaveBeenCalledWith({
      questionnaireId: "q-test-1",
      asset: "blusdc",
      venue: "blend",
      amount: { kind: "literal", amount: "100" },
      summary: "Supply 100 BLUSDC to Blend",
    });
  });

  it("displays LP pair ratio and matches pool ratio when perUnit is known", () => {
    render(
      <ClarifyQuestionnaire
        questionnaire={mockQuestionnaire}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onSomethingElse={vi.fn()}
      />
    );

    // Pick AQUSDC -> auto-skips to Amount with pool_xlm_aqusdc
    fireEvent.click(screen.getByTestId("option-aqusdc"));

    const input = screen.getByPlaceholderText(/0.0 or 50%/i);
    fireEvent.change(input, { target: { value: "100" } });

    // With 100 AQUSDC and 2.5 perUnit, matched amount is 250 XLM
    const lpNote = screen.getByTestId("lp-pair-ratio");
    expect(lpNote.textContent).toContain("XLM is matched at the pool ratio");
    expect(lpNote.textContent).toContain("250 XLM");
  });

  it("X calls onCancel", () => {
    const handleCancel = vi.fn();
    render(
      <ClarifyQuestionnaire
        questionnaire={mockQuestionnaire}
        onSubmit={vi.fn()}
        onCancel={handleCancel}
        onSomethingElse={vi.fn()}
      />
    );

    const cancelBtn = screen.getByTestId("questionnaire-cancel-btn");
    fireEvent.click(cancelBtn);

    expect(handleCancel).toHaveBeenCalledTimes(1);
  });

  it("Something else calls onSomethingElse", () => {
    const handleSomethingElse = vi.fn();
    render(
      <ClarifyQuestionnaire
        questionnaire={mockQuestionnaire}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onSomethingElse={handleSomethingElse}
      />
    );

    const input = screen.getByTestId("input-something-else");
    fireEvent.change(input, { target: { value: "I want to deposit into margin instead" } });

    const btn = screen.getByTestId("btn-something-else");
    fireEvent.click(btn);

    expect(handleSomethingElse).toHaveBeenCalledTimes(1);
    expect(handleSomethingElse).toHaveBeenCalledWith("I want to deposit into margin instead");
  });

  it("keyboard navigation moves with ArrowDown/ArrowUp and selects with Enter", () => {
    render(
      <ClarifyQuestionnaire
        questionnaire={mockQuestionnaire}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onSomethingElse={vi.fn()}
      />
    );

    const container = screen.getByRole("region", { name: /Clarify request/i });

    // Initially focused on first option (BLUSDC)
    // Press ArrowDown to focus AQUSDC
    fireEvent.keyDown(container, { key: "ArrowDown" });
    // Press Enter to select AQUSDC
    fireEvent.keyDown(container, { key: "Enter" });

    // Should have selected AQUSDC and advanced (auto-skipping venue to Amount)
    expect(screen.getByTestId("step-counter").textContent).toContain("3 of 3");
  });

  it("buildQuestionnaireSummary generates expected summaries for various actions", () => {
    const sum1 = buildQuestionnaireSummary(
      mockQuestionnaire,
      { id: "blusdc", label: "BLUSDC" },
      { id: "earn", label: "Earn" },
      { kind: "fraction", percent: "50" }
    );
    expect(sum1).toBe("Supply 50% of my BLUSDC to Earn");

    const sum2 = buildQuestionnaireSummary(
      mockQuestionnaire,
      { id: "blusdc", label: "BLUSDC" },
      null,
      { kind: "literal", amount: "500" }
    );
    expect(sum2).toBe("Supply 500 BLUSDC");
  });
});
