// @vitest-environment happy-dom

/**
 * `data-copilot-id` is the contract the Guide points at. The Earn and Farm forms mount
 * the same panel twice — a desktop card and a mobile sheet, both in the DOM — so the
 * naive `querySelector` picked whichever came first, which on desktop can be the hidden
 * one: the page then scrolls to nothing and the pulse lands off-screen. The hint list had
 * the same problem in reverse, offering the model duplicate labels.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { highlightElement } from "@/lib/assistant/client-tools";
import { captureSemanticPageContext } from "@/lib/assistant/semantic-page-context";

function render(html: string) {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("assistant page anchors", () => {
  it("highlights the visible copy when an id is mounted twice", () => {
    render(`
      <main>
        <div style="display: none">
          <div data-copilot-id="earn-supply" id="mobile-sheet">Supply (mobile)</div>
        </div>
        <div>
          <div data-copilot-id="earn-supply" id="desktop-card">Supply (desktop)</div>
        </div>
      </main>
    `);

    const res = highlightElement("earn-supply");
    expect(res.ok).toBe(true);
    expect(document.getElementById("desktop-card")?.className).toContain(
      "copilot-target-highlight",
    );
    expect(document.getElementById("mobile-sheet")?.className ?? "").not.toContain(
      "copilot-target-highlight",
    );
  });

  it("offers each anchor to the model once, and only when visible", () => {
    render(`
      <main>
        <h2>Earn</h2>
        <div style="display: none">
          <div data-copilot-id="earn-supply" aria-label="Supply mobile"></div>
        </div>
        <div data-copilot-id="earn-supply" aria-label="Supply"></div>
        <div data-copilot-id="earn-withdraw" aria-label="Withdraw"></div>
      </main>
    `);

    const ctx = captureSemanticPageContext();
    const ids = ctx.interactiveHints.map((h) => h.id);
    expect(ids).toEqual(["earn-supply", "earn-withdraw"]);
    expect(ctx.interactiveHints.find((h) => h.id === "earn-supply")?.label).toBe("Supply");
  });

  it("reports a miss instead of highlighting something arbitrary", () => {
    render(`<main><div data-copilot-id="earn-supply"></div></main>`);
    expect(highlightElement("margin-repay").ok).toBe(false);
  });
});
