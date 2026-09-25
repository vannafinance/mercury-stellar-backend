// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeProvider } from "@/contexts/theme-context";
import {
  ClarifyQuestionnaire,
  buildQuestionnaireSummary,
} from "@/components/copilot/clarify-questionnaire";
import type { Questionnaire } from "@/lib/copilot/investigation/view";

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

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

const mockMultiSectionQuestionnaire: Questionnaire = {
  id: "q-multi-1",
  title: "Deposit XLM and Supply to Blend",
  subtitle: "Multiple actions in your request",
  steps: [],
  sections: [
    {
      id: "sec-deposit",
      title: "Deposit XLM",
      actionIndex: 0,
      steps: [
        {
          slot: "asset",
          prompt: "Which asset?",
          options: [{ id: "xlm", label: "XLM", detail: "1000 in wallet" }],
        },
        {
          slot: "amount",
          prompt: "How much XLM?",
          options: [],
          max: {
            xlm: { amount: "1000", asset: "XLM", where: "wallet" },
          },
          presets: [
            { id: "25", label: "25%", percent: "25" },
            { id: "50", label: "50%", percent: "50" },
            { id: "100", label: "Max", percent: "100" },
          ],
        },
      ],
    },
    {
      id: "sec-blend",
      title: "Supply to Blend",
      actionIndex: 1,
      steps: [
        {
          slot: "asset",
          prompt: "Which asset?",
          options: [
            { id: "xlm", label: "XLM", detail: "Blend takes XLM" },
            { id: "blusdc", label: "BLUSDC", detail: "Blend takes BLUSDC" },
          ],
        },
        {
          slot: "amount",
          prompt: "How much to supply?",
          options: [
            {
              id: "linked-xlm",
              sourceSectionId: "sec-deposit",
              label: "All of the XLM you just deposited",
              detail: "1000 XLM",
            },
          ],
          max: {
            xlm: { amount: "1000", asset: "XLM", where: "margin account" },
            blusdc: { amount: "680", asset: "BLUSDC", where: "margin account" },
          },
          presets: [
            { id: "50", label: "50%", percent: "50" },
            { id: "100", label: "Max", percent: "100" },
          ],
        },
      ],
    },
  ],
};

describe("ClarifyQuestionnaire Component", () => {
  it("renders title, subtitle, and step counter", () => {
    renderWithTheme(
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
    renderWithTheme(
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
    renderWithTheme(
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

    renderWithTheme(
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
    expect(screen.getByText(/Which asset\?|Asset/i)).toBeTruthy();
  });

  it("max blocks an over-amount and keeps Send disabled", () => {
    renderWithTheme(
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
    renderWithTheme(
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

    // 50% of 680 = 340, written INTO the amount box as the Margin page does, not left as "50%".
    expect((screen.getByPlaceholderText("0.0 or 50%") as HTMLInputElement).value).toBe("340");

    // Send button should be enabled
    const sendBtn = screen.getByTestId("btn-send");
    expect(sendBtn.hasAttribute("disabled")).toBe(false);
  });

  it("Send stays disabled until complete, then submits exact answers and summary", () => {
    const handleSubmit = vi.fn();
    renderWithTheme(
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
      amount: { kind: "literal", amount: "340" },
      summary: "Supply 340 BLUSDC to Earn",
    });
  });

  it("submits literal amount answers and summary correctly", () => {
    const handleSubmit = vi.fn();
    renderWithTheme(
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
    renderWithTheme(
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
    renderWithTheme(
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
    renderWithTheme(
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
    renderWithTheme(
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

  // ADDENDUM 1: Editing before Send tests
  describe("Addendum 1: Editing before Send", () => {
    it("clicking an answered row reopens that step with its current answer selected", () => {
      renderWithTheme(
        <ClarifyQuestionnaire
          questionnaire={mockQuestionnaire}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          onSomethingElse={vi.fn()}
        />
      );

      // Select BLUSDC -> arrives at Venue
      fireEvent.click(screen.getByTestId("option-blusdc"));
      expect(screen.getByTestId("step-counter").textContent).toContain("2 of 3");

      // Click answered Step 0 (Asset)
      const answeredAsset = screen.getByTestId("answered-step-0");
      expect(answeredAsset.textContent).toContain("BLUSDC");
      fireEvent.click(answeredAsset);

      // Should be back on Step 1 (Asset)
      expect(screen.getByTestId("step-counter").textContent).toContain("1 of 3");
      const blusdcRadio = screen.getByTestId("option-blusdc");
      expect(blusdcRadio.getAttribute("aria-checked")).toBe("true");
    });

    it("clicking the back arrow reopens previous step with current answer selected", () => {
      renderWithTheme(
        <ClarifyQuestionnaire
          questionnaire={mockQuestionnaire}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          onSomethingElse={vi.fn()}
        />
      );

      fireEvent.click(screen.getByTestId("option-blusdc"));
      expect(screen.getByTestId("step-counter").textContent).toContain("2 of 3");

      const backBtn = screen.getByTestId("btn-back");
      fireEvent.click(backBtn);

      expect(screen.getByTestId("step-counter").textContent).toContain("1 of 3");
      expect(screen.getByTestId("option-blusdc").getAttribute("aria-checked")).toBe("true");
    });

    it("changing an earlier answer keeps later answers ONLY if still valid; clears invalid venue", () => {
      renderWithTheme(
        <ClarifyQuestionnaire
          questionnaire={mockQuestionnaire}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          onSomethingElse={vi.fn()}
        />
      );

      // Select BLUSDC -> Earn -> Amount 100
      fireEvent.click(screen.getByTestId("option-blusdc"));
      fireEvent.click(screen.getByTestId("option-earn"));
      const input = screen.getByPlaceholderText(/0.0 or 50%/i);
      fireEvent.change(input, { target: { value: "100" } });

      // Click answered Step 0 to change Asset from BLUSDC to AQUSDC
      fireEvent.click(screen.getByTestId("answered-step-0"));
      // AQUSDC does NOT support Earn (only pool_xlm_aqusdc)
      fireEvent.click(screen.getByTestId("option-aqusdc"));

      // Venue 'earn' was invalid for AQUSDC, so it was cleared.
      // AQUSDC auto-selects its only valid venue (pool_xlm_aqusdc) and amount 100 <= 200 (max) is kept!
      expect(screen.getByTestId("step-counter").textContent).toContain("3 of 3");
      const amountInput = screen.getByPlaceholderText(/0.0 or 50%/i) as HTMLInputElement;
      expect(amountInput.value).toBe("100");
    });

    it("changing an earlier answer clears amount if it exceeds the new max", () => {
      renderWithTheme(
        <ClarifyQuestionnaire
          questionnaire={mockQuestionnaire}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          onSomethingElse={vi.fn()}
        />
      );

      // Select BLUSDC (max 680) -> Blend (max 680) -> Amount 600
      fireEvent.click(screen.getByTestId("option-blusdc"));
      fireEvent.click(screen.getByTestId("option-blend"));
      const input = screen.getByPlaceholderText(/0.0 or 50%/i);
      fireEvent.change(input, { target: { value: "600" } });

      // Reopen Step 0 (Asset) and change to AQUSDC (pool max is 200)
      fireEvent.click(screen.getByTestId("answered-step-0"));
      fireEvent.click(screen.getByTestId("option-aqusdc"));

      // 600 > 200 (new max for AQUSDC pool), so amount was cleared and Amount step is shown again
      expect(screen.getByTestId("step-counter").textContent).toContain("3 of 3");
      const amountInput = screen.getByPlaceholderText(/0.0 or 50%/i) as HTMLInputElement;
      expect(amountInput.value).toBe("");
      // Send button must be disabled because amount is empty
      expect(screen.getByTestId("btn-send").hasAttribute("disabled")).toBe(true);
    });

    it("after Send, nothing is editable", () => {
      const handleSubmit = vi.fn();
      renderWithTheme(
        <ClarifyQuestionnaire
          questionnaire={mockQuestionnaire}
          onSubmit={handleSubmit}
          onCancel={vi.fn()}
          onSomethingElse={vi.fn()}
        />
      );

      fireEvent.click(screen.getByTestId("option-blusdc"));
      fireEvent.click(screen.getByTestId("option-earn"));
      fireEvent.click(screen.getByTestId("preset-50"));

      const sendBtn = screen.getByTestId("btn-send");
      fireEvent.click(sendBtn);

      expect(handleSubmit).toHaveBeenCalledTimes(1);

      // Inputs and buttons must be disabled after Send
      expect(sendBtn.hasAttribute("disabled")).toBe(true);
      const amountInput = screen.getByPlaceholderText(/0.0 or 50%/i);
      expect(amountInput.hasAttribute("disabled")).toBe(true);
      const somethingElseInput = screen.getByTestId("input-something-else");
      expect(somethingElseInput.hasAttribute("disabled")).toBe(true);
    });
  });

  // ADDENDUM 2: Multi-Action Sections tests
  describe("Addendum 2: Multi-Action Sections", () => {
    it("renders section checklist at top when questionnaire.sections > 1", () => {
      renderWithTheme(
        <ClarifyQuestionnaire
          questionnaire={mockMultiSectionQuestionnaire}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          onSomethingElse={vi.fn()}
        />
      );

      // Section checklist must be rendered
      const checklist = screen.getByTestId("section-checklist");
      expect(checklist).toBeTruthy();
      expect(screen.getByTestId("section-item-0")).toBeTruthy();
      expect(screen.getByTestId("section-item-1")).toBeTruthy();
    });

    it("advances through sections and enables Send only when all sections are complete", () => {
      const handleSubmit = vi.fn();
      renderWithTheme(
        <ClarifyQuestionnaire
          questionnaire={mockMultiSectionQuestionnaire}
          onSubmit={handleSubmit}
          onCancel={vi.fn()}
          onSomethingElse={vi.fn()}
        />
      );

      const sendBtn = screen.getByTestId("btn-send");
      expect(sendBtn.hasAttribute("disabled")).toBe(true);

      // Section 0: Deposit XLM (Asset auto-skipped, on Amount)
      const inputSec0 = screen.getByPlaceholderText(/0.0 or 50%/i);
      fireEvent.change(inputSec0, { target: { value: "500" } });

      // Click Next to advance to Section 1
      const nextBtn = screen.getByTestId("btn-next");
      fireEvent.click(nextBtn);

      // In Section 1: Supply to Blend. Pick XLM
      expect(sendBtn.hasAttribute("disabled")).toBe(true);
      fireEvent.click(screen.getByTestId("option-xlm"));

      // Section 1 amount step: Click linked option "All of the XLM you just deposited"
      const linkedOpt = screen.getByTestId("option-linked-xlm");
      expect(linkedOpt.textContent).toContain("All of the XLM you just deposited");
      // Its detail should dynamically reflect Section 0 amount (500)
      expect(linkedOpt.textContent).toContain("500 XLM");
      fireEvent.click(linkedOpt);

      // Both sections complete! Send should now be enabled
      expect(sendBtn.hasAttribute("disabled")).toBe(false);

      fireEvent.click(sendBtn);

      expect(handleSubmit).toHaveBeenCalledTimes(1);
      expect(handleSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          questionnaireId: "q-multi-1",
          sections: [
            {
              sectionId: "sec-deposit",
              asset: "xlm",
              venue: null,
              amount: { kind: "literal", amount: "500" },
            },
            {
              sectionId: "sec-blend",
              asset: "xlm",
              venue: null,
              amount: { kind: "previous_leg" },
            },
          ],
        })
      );
    });

    it("linked option dynamically follows earlier section amount changes", () => {
      renderWithTheme(
        <ClarifyQuestionnaire
          questionnaire={mockMultiSectionQuestionnaire}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          onSomethingElse={vi.fn()}
        />
      );

      // Section 0: enter 500 XLM
      const inputSec0 = screen.getByPlaceholderText(/0.0 or 50%/i);
      fireEvent.change(inputSec0, { target: { value: "500" } });
      fireEvent.click(screen.getByTestId("btn-next"));

      // Section 1: pick XLM -> see linked option
      fireEvent.click(screen.getByTestId("option-xlm"));
      const linkedOpt = screen.getByTestId("option-linked-xlm");
      expect(linkedOpt.textContent).toContain("500 XLM");
      fireEvent.click(linkedOpt);

      // Reopen Section 0 from the top checklist
      const sec0Item = screen.getByTestId("section-item-0");
      fireEvent.click(sec0Item);

      // Change Section 0 amount to 250
      const inputSec0Reopened = screen.getByPlaceholderText(/0.0 or 50%/i);
      fireEvent.change(inputSec0Reopened, { target: { value: "250" } });

      // Navigate back to Section 1 by clicking section-item-1, then Next to Amount step
      fireEvent.click(screen.getByTestId("section-item-1"));
      fireEvent.click(screen.getByTestId("btn-next"));

      // Linked option in Section 1 should now show 250 XLM
      const updatedLinkedOpt = screen.getByTestId("option-linked-xlm");
      expect(updatedLinkedOpt.textContent).toContain("250 XLM");
    });

    it("displays note fields on max and pair under the amount box", () => {
      const questionnaireWithNotes: Questionnaire = {
        id: "q-notes",
        title: "Supply to LP Pool",
        subtitle: "Pool supply with notes",
        steps: [
          {
            slot: "asset",
            prompt: "Which asset?",
            options: [{ id: "aqusdc", label: "AQUSDC" }],
          },
          {
            slot: "venue",
            prompt: "Where?",
            options: [{ id: "pool_xlm_aqusdc", label: "Pool" }],
          },
          {
            slot: "amount",
            prompt: "How much?",
            options: [],
            max: {
              pool_xlm_aqusdc: {
                amount: "24",
                asset: "AQUSDC",
                where: "wallet",
                note: "Your margin account has 10 AQUSDC; I'll deposit the other 14 from your wallet first.",
              },
            },
            pair: {
              pool_xlm_aqusdc: {
                asset: "XLM",
                perUnit: "2.5",
                note: "Paired with XLM at pool ratio",
              },
            },
          },
        ],
      };

      renderWithTheme(
        <ClarifyQuestionnaire
          questionnaire={questionnaireWithNotes}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          onSomethingElse={vi.fn()}
        />
      );

      // Both single-option steps (asset & venue) are auto-skipped, lands directly on amount step
      const amountNote = screen.getByTestId("amount-note");
      expect(amountNote).toBeTruthy();
      expect(amountNote.textContent).toContain("Your margin account has 10 AQUSDC; I'll deposit the other 14 from your wallet first.");

      const pairNote = screen.getByTestId("pair-note");
      expect(pairNote).toBeTruthy();
      expect(pairNote.textContent).toContain("Paired with XLM at pool ratio");
    });

    it("resolves linked option strictly via sourceSectionId and submits previous_leg", () => {
      const qWithSourceSectionId: Questionnaire = {
        id: "q-source-sec",
        title: "Deposit and Farm",
        subtitle: "Multi-leg strategy",
        steps: [],
        sections: [
          {
            id: "leg-1",
            title: "Deposit USDC",
            actionIndex: 0,
            steps: [
              {
                slot: "asset",
                prompt: "Asset",
                options: [{ id: "usdc", label: "USDC" }],
              },
              {
                slot: "amount",
                prompt: "Amount",
                options: [],
                max: { usdc: { amount: "1000", asset: "USDC", where: "wallet" } },
              },
            ],
          },
          {
            id: "leg-2",
            title: "Supply USDC to Blend",
            actionIndex: 1,
            steps: [
              {
                slot: "asset",
                prompt: "Asset",
                options: [{ id: "usdc", label: "USDC" }],
              },
              {
                slot: "amount",
                prompt: "Amount",
                options: [
                  {
                    id: "link-leg1",
                    sourceSectionId: "leg-1",
                    label: "Whatever was deposited in step 1",
                  },
                ],
                max: { usdc: { amount: "1000", asset: "USDC", where: "margin account" } },
              },
            ],
          },
        ],
      };

      const handleSubmit = vi.fn();
      renderWithTheme(
        <ClarifyQuestionnaire
          questionnaire={qWithSourceSectionId}
          onSubmit={handleSubmit}
          onCancel={vi.fn()}
          onSomethingElse={vi.fn()}
        />
      );

      // In Leg 1: enter 420 USDC
      const inputLeg1 = screen.getByPlaceholderText(/0.0 or 50%/i);
      fireEvent.change(inputLeg1, { target: { value: "420" } });
      fireEvent.click(screen.getByTestId("btn-next"));

      // In Leg 2: see linked option resolved via sourceSectionId
      const linkedOption = screen.getByTestId("option-link-leg1");
      expect(linkedOption.textContent).toContain("Whatever was deposited in step 1");
      expect(linkedOption.textContent).toContain("420 USDC");
      fireEvent.click(linkedOption);

      // Submit
      const sendBtn = screen.getByTestId("btn-send");
      expect(sendBtn.hasAttribute("disabled")).toBe(false);
      fireEvent.click(sendBtn);

      expect(handleSubmit).toHaveBeenCalledTimes(1);
      expect(handleSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          questionnaireId: "q-source-sec",
          sections: [
            {
              sectionId: "leg-1",
              asset: "usdc",
              venue: null,
              amount: { kind: "literal", amount: "420" },
            },
            {
              sectionId: "leg-2",
              asset: "usdc",
              venue: null,
              amount: { kind: "previous_leg" },
            },
          ],
        })
      );
    });

    it("typed amount is not overwritten by linked option when earlier section changes, and linked option hides for mismatched asset", () => {
      const questionnaire: Questionnaire = {
        id: "q-sync-test",
        title: "Deposit and Blend",
        subtitle: "Multi-leg strategy",
        steps: [],
        sections: [
          {
            id: "sec-deposit",
            title: "Deposit XLM",
            op: "deposit_collateral",
            actionIndex: 0,
            steps: [
              {
                slot: "asset",
                prompt: "Asset",
                options: [{ id: "xlm", label: "XLM" }],
              },
              {
                slot: "amount",
                prompt: "Amount",
                options: [],
                max: { xlm: { amount: "1000", asset: "XLM", where: "wallet" } },
              },
            ],
          },
          {
            id: "sec-blend",
            title: "Supply to Blend",
            op: "supply_blend",
            actionIndex: 1,
            steps: [
              {
                slot: "asset",
                prompt: "Asset",
                options: [
                  { id: "xlm", label: "XLM" },
                  { id: "usdc", label: "USDC" },
                ],
              },
              {
                slot: "amount",
                prompt: "Amount",
                options: [
                  {
                    id: "link-dep",
                    sourceSectionId: "sec-deposit",
                    forAsset: "xlm",
                    label: "All of earlier deposit",
                  },
                ],
                max: {
                  xlm: { amount: "1000", asset: "XLM", where: "wallet" },
                  usdc: { amount: "500", asset: "USDC", where: "wallet" },
                },
              },
            ],
          },
        ],
      };

      const handleSubmit = vi.fn();
      renderWithTheme(
        <ClarifyQuestionnaire
          questionnaire={questionnaire}
          onSubmit={handleSubmit}
          onCancel={vi.fn()}
          onSomethingElse={vi.fn()}
        />
      );

      // Section 1: deposit 500
      const inputDeposit = screen.getByPlaceholderText(/0.0 or 50%/i);
      fireEvent.change(inputDeposit, { target: { value: "500" } });
      fireEvent.click(screen.getByTestId("btn-next"));

      // Section 2: select XLM to advance to Amount step
      fireEvent.click(screen.getByTestId("option-xlm"));

      // Check linked option is visible when asset is XLM
      expect(screen.getByTestId("option-link-dep")).toBeDefined();

      // Type 30 for Blend
      const inputBlend = screen.getByPlaceholderText(/0.0 or 50%/i);
      fireEvent.change(inputBlend, { target: { value: "30" } });

      // Change deposit to 250: click Section 1 tab (section-item-0)
      fireEvent.click(screen.getByTestId("section-item-0"));
      const inputDepositAgain = screen.getByPlaceholderText(/0.0 or 50%/i);
      fireEvent.change(inputDepositAgain, { target: { value: "250" } });
      fireEvent.click(screen.getByTestId("btn-next"));

      // In Section 2: Blend remains 30!
      const inputBlendAgain = screen.getByPlaceholderText(/0.0 or 50%/i);
      expect((inputBlendAgain as HTMLInputElement).value).toBe("30");

      // Verify linked option is hidden if incompatible asset is picked
      // Click answered asset step in Section 2 to change asset to USDC
      const answeredAsset = screen.getByTestId("answered-step-0");
      fireEvent.click(answeredAsset);
      // Select USDC
      fireEvent.click(screen.getByTestId("option-usdc"));
      // Now in amount step, linked option (forAsset: "xlm") should NOT be in the document
      expect(screen.queryByTestId("option-link-dep")).toBeNull();

      // Switch back to XLM to test submit with typed 30
      fireEvent.click(screen.getByTestId("answered-step-0"));
      fireEvent.click(screen.getByTestId("option-xlm"));
      fireEvent.change(screen.getByPlaceholderText(/0.0 or 50%/i), { target: { value: "30" } });

      // Send submits Blend 30
      const sendBtn = screen.getByTestId("btn-send");
      fireEvent.click(sendBtn);

      expect(handleSubmit).toHaveBeenCalledTimes(1);
      expect(handleSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          sections: [
            expect.objectContaining({
              sectionId: "sec-deposit",
              amount: { kind: "literal", amount: "250" },
            }),
            expect.objectContaining({
              sectionId: "sec-blend",
              amount: { kind: "literal", amount: "30" },
            }),
          ],
        })
      );
    });
  });
});
