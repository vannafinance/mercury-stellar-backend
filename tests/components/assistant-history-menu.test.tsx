// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssistantHistoryMenu } from "@/components/copilot/assistant-history-menu";
import { appendAssistantTurn, clearAssistantTurns, useAssistantSessionStore } from "@/store/assistant-session";

const say = (q: string) => { appendAssistantTurn({ role: "user", text: q }); appendAssistantTurn({ role: "assistant", text: "ok" }); };

beforeEach(() => { useAssistantSessionStore.setState({ turns: [], history: [] }); });
afterEach(cleanup);

describe("Assist chat history menu", () => {
  it("says so when there is nothing yet", () => {
    render(<AssistantHistoryMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    expect(screen.getByText("No earlier chats yet.")).toBeTruthy();
  });

  it("lists the current chat and earlier ones, and opens an earlier one", () => {
    say("first question");
    clearAssistantTurns();
    say("second question");
    render(<AssistantHistoryMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    const menu = screen.getByRole("menu", { name: "Chat history" });
    expect(within(menu).getByText("second question").closest("[aria-current]")).toBeTruthy();
    fireEvent.click(within(menu).getByText("first question"));
    expect(useAssistantSessionStore.getState().turns[0].text).toBe("first question");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("never shows more than five rows, so it cannot cover the panel", () => {
    for (let i = 0; i < 8; i += 1) { say(`earlier ${i}`); clearAssistantTurns(); }
    say("the chat on screen");
    render(<AssistantHistoryMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    const rows = screen.getAllByRole("menuitem");
    expect(rows).toHaveLength(5);
    expect(rows[0].textContent).toContain("the chat on screen");
  });

  it("closes on Escape", () => {
    say("a question");
    render(<AssistantHistoryMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
