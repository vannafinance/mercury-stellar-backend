// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantBody, ReplyBlocksBody } from "@/components/copilot/chat-message";
import type { ReplyBlock } from "@/lib/copilot/investigation/view";

afterEach(cleanup);
describe("structured reply rendering", () => {
  it("restores legacy serialized lists and uses the same text size in every section", () => {
    const { container } = render(<AssistantBody text={"Collateral:\n- ExampleAsset 12.25\n- OtherAsset 3.50\n\nDebt:\n- OtherAsset 1.25"} />);
    expect(container.querySelectorAll("ul")).toHaveLength(2);
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(container.textContent).not.toContain("- ExampleAsset");
    for (const node of container.querySelectorAll("p, ul")) expect((node as HTMLElement).style.fontSize).toBe("16px");
  });
  it("renders semantic headings, bullets, ordered steps and comparison columns directly", () => {
    const blocks: ReplyBlock[] = [
      { type: "paragraph", segments: [{ text: "Here is the breakdown." }] },
      { type: "heading", segments: [{ text: "Holdings" }] },
      { type: "bullets", items: [[{ text: "Wallet balance " }, { text: "14.25 ExampleAsset", figure: true }]] },
      { type: "steps", items: [[{ text: "Review the options." }], [{ text: "Approve the chosen option." }]] },
      { type: "table", columns: [[{ text: "Location" }], [{ text: "Amount" }]], rows: [[[{ text: "Wallet" }], [{ text: "14.25 ExampleAsset", figure: true }]]] },
    ];
    const { container } = render(<ReplyBlocksBody blocks={blocks} />);
    expect(screen.getByRole("heading", { name: "Holdings" }).tagName).toBe("H3");
    expect(container.querySelector("ul")?.textContent).toContain("Wallet balance");
    expect(within(container.querySelector("ol")!).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getAllByRole("columnheader").map((el) => el.textContent)).toEqual(["Location", "Amount"]);
    expect(within(screen.getByRole("table")).getAllByRole("cell").map((el) => el.textContent)).toEqual(["Wallet", "14.25 ExampleAsset"]);
  });

  it("keeps previous saved segments valid and renders display text without executing markup", () => {
    const { container } = render(<ReplyBlocksBody blocks={[{ type: "paragraph", segments: [{ text: "<img src=x onerror=alert()>" }, { text: "2.32", figure: true }] }]} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert()>");
    expect(container.querySelector("strong")?.textContent).toBe("2.32");
  });
});
