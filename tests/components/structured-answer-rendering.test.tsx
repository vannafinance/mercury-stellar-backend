// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { AssistantBody, AssistantMessage, chatBlocksFromStored } from "@/components/copilot/chat-message";
import { followUpFor } from "@/components/copilot/copilot-workspace";
import { answerToText } from "@/lib/copilot/answer-schema";
import type { StructuredAnswer } from "@/lib/copilot/answer-schema";

describe("F3: Structured answers render headline, facts, note, and table identically in live and stored paths", () => {
  const structured: StructuredAnswer = {
    headline: "Your wallet holds 7,666.2892 native XLM and 598 BLUSDC.",
    facts: [
      { label: "Native XLM", value: "7,666.2892" },
      { label: "Spendable XLM", value: "7,662.2892" },
      { label: "BLUSDC", value: "598" },
      { label: "AQUSDC", value: "4,956.5415" },
    ],
    table: {
      columns: ["Asset", "Balance", "Venue"],
      rows: [
        ["XLM", "7,666.2892", "Stellar"],
        ["BLUSDC", "598", "Blend"],
      ],
    },
    note: "Reserve requirements are excluded from spendable figures.",
  };

  it("produces identical blocks for live and stored paths from the same answer payload", () => {
    const serializedMessage = answerToText(structured);
    const blocks = chatBlocksFromStored(serializedMessage);

    // Headline block
    const pBlock = blocks.find((b) => b.kind === "p");
    expect(pBlock).toBeDefined();
    expect(pBlock?.kind === "p" && pBlock.text).toContain("7,666.2892");

    // Facts block
    const factsBlock = blocks.find((b) => b.kind === "facts");
    expect(factsBlock).toBeDefined();
    if (factsBlock?.kind === "facts") {
      expect(factsBlock.rows).toHaveLength(4);
      expect(factsBlock.rows.some((r) => r.label === "Native XLM" && r.value === "7,666.2892")).toBe(true);
    }

    // Table block
    const tableBlock = blocks.find((b) => b.kind === "table");
    expect(tableBlock).toBeDefined();
    if (tableBlock?.kind === "table") {
      expect(tableBlock.rows).toHaveLength(3); // 1 header + 2 rows
    }
  });

  it("renders all components (headline, fact rows, and table) on screen via AssistantMessage", () => {
    const serializedMessage = answerToText(structured);
    render(
      <AssistantMessage note={structured.note}>
        {serializedMessage}
      </AssistantMessage>
    );

    // Headline rendered
    expect(screen.getByText(/Your wallet holds 7,666.2892 native XLM/i)).toBeTruthy();

    // Facts rendered
    expect(screen.getByText("Native XLM")).toBeTruthy();
    expect(screen.getByText("7,662.2892")).toBeTruthy();
    expect(screen.getByText("AQUSDC")).toBeTruthy();

    // Table rendered
    expect(screen.getByText("Asset")).toBeTruthy();
    expect(screen.getByText("Venue")).toBeTruthy();
    expect(screen.getByText("Stellar")).toBeTruthy();

    // Note rendered
    expect(screen.getAllByText(/Reserve requirements are excluded from spendable figures/i).length).toBeGreaterThanOrEqual(1);
  });
});

describe("F4: Follow-up chips derive dynamically from live figures or return undefined (zero canned maps)", () => {
  it("returns undefined for pure wallet reads rather than inventing writes", () => {
    const followUp = followUpFor(
      {
        headline: "You hold 7,666 XLM.",
        facts: [{ label: "XLM", value: "7666" }],
      },
      { template_id: "vanna_get_wallet_balance", slots: {} }
    );
    expect(followUp).toBeUndefined();
  });

  it("returns undefined for price reads rather than suggesting ambiguous bare USDC stats", () => {
    const followUp = followUpFor(
      {
        headline: "USDC price is $1.00",
        facts: [],
      },
      { template_id: "vanna_get_price", slots: { symbol: "USDC" } }
    );
    expect(followUp).toBeUndefined();
  });

  it("derives an actionable follow-up from live capacity check slots without inventing amounts", () => {
    const followUp = followUpFor(
      {
        headline: "You can borrow 20 XLM.",
        facts: [],
      },
      {
        template_id: "query_can_borrow",
        slots: { amount: "20", symbol: "XLM" },
      }
    );
    expect(followUp).toBe("Borrow 20 XLM");
  });

  it("derives repayment from live debt in answer facts", () => {
    const followUp = followUpFor(
      {
        headline: "Your BLUSDC debt is 5.004161.",
        facts: [{ label: "Borrowed Debt", value: "5.004161" }],
      },
      {
        template_id: "query_debt",
        slots: { symbol: "BLUSDC" },
      }
    );
    expect(followUp).toBe("Repay 5.004161 BLUSDC");
  });

  it("returns undefined when tool is in neither old map and has no actionable figure", () => {
    const followUp = followUpFor(
      {
        headline: "Oracle feed active",
        facts: [],
      },
      {
        template_id: "vanna_oracle_heartbeat",
        slots: {},
      }
    );
    expect(followUp).toBeUndefined();
  });
});
