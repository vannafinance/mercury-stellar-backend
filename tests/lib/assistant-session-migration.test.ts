// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

describe("assistant-session persisted state", () => {
  it("migrates a v1 saved session without an error and keeps the chat", async () => {
    localStorage.setItem("assistant-session", JSON.stringify({
      state: { turns: [{ role: "user", text: "hello" }], open: true },
      version: 1,
    }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.resetModules();
    const { useAssistantSessionStore } = await import("@/store/assistant-session");
    const state = useAssistantSessionStore.getState();
    expect(state.turns).toHaveLength(1);
    expect(state.open).toBe(true);
    expect(state.launcherPos).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
