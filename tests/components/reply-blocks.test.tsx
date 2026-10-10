// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ChatTurns } from "@/components/copilot/chat-message";
import type { ThreadTurn } from "@/lib/copilot/investigation/thread";

/** A composed reply draws as blocks with its audited figures set apart; a plain turn is untouched. */
describe("composed reply blocks in the thread", () => {
  const composed: ThreadTurn[] = [
    { role: "user", text: "what's my health factor?" },
    {
      role: "assistant",
      text: "Your health factor is 2.32, comfortably above liquidation.\n\n• Collateral: $5,001.91",
      blocks: [
        { type: "paragraph", segments: [{ text: "Your health factor is " }, { text: "2.32", figure: true }, { text: ", comfortably above liquidation." }] },
        { type: "bullets", items: [[{ text: "Collateral: " }, { text: "$5,001.91", figure: true }]] },
      ],
    },
  ];

  it("renders paragraphs and bullets, with figures in bold", () => {
    const { container } = render(<ChatTurns turns={composed} />);
    const figures = [...container.querySelectorAll("strong")].map((node) => node.textContent);
    expect(figures).toEqual(["2.32", "$5,001.91"]);
    expect(container.querySelectorAll("ul li")).toHaveLength(1);
    expect(container.textContent).toContain("comfortably above liquidation.");
  });

  it("draws a turn without blocks exactly as before", () => {
    const plain: ThreadTurn[] = [composed[0], { role: "assistant", text: composed[1].text }];
    const { container } = render(<ChatTurns turns={plain} />);
    expect(container.querySelectorAll("strong")).toHaveLength(0);
    expect(container.textContent).toContain("Your health factor is 2.32");
  });
});
