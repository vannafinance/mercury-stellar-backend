// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CopilotRailPresentation } from "@/components/copilot/copilot-shell";
import { CopilotRailBody } from "@/components/copilot/copilot-rail";
import { AutoApproveMenu, type AutoApproveMenuProps } from "@/components/copilot/auto-approve-menu";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("compact rail presentation", () => {
  it.each([true, false])("keeps the last chat's complete menu inside the viewport (pin available: %s)", (pinAvailable) => {
    const height = pinAvailable ? 132 : 92;
    vi.stubGlobal("visualViewport", { width: 390, height: 620, offsetLeft: 0, offsetTop: 0, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "menu"
        ? new DOMRect(0, 0, 150, height) : new DOMRect(350, 594, 24, 24);
    });
    render(<CopilotRailBody hasWallet healthFactor={null} positions={[]} conversations={[{ id: "saved", title: "Last chat", createdAt: 1, updatedAt: 1 }]} activeId="saved" onOpen={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onPin={pinAvailable ? vi.fn() : undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Chat actions" }));
    const menu = screen.getByRole("menu", { name: "Chat actions" });
    expect(Number.parseFloat(menu.style.top) + height).toBeLessThanOrEqual(620);
    expect(Number.parseFloat(menu.style.left) + 150).toBeLessThanOrEqual(390);
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });
  it("allows scrolling an oversized actions menu without closing it", () => {
    vi.stubGlobal("visualViewport", { width: 390, height: 90, offsetLeft: 0, offsetTop: 0, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "menu"
        ? new DOMRect(0, 0, 150, 132) : new DOMRect(350, 70, 24, 24);
    });
    render(<CopilotRailBody hasWallet healthFactor={null} positions={[]} conversations={[{ id: "saved", title: "Last chat", createdAt: 1, updatedAt: 1 }]} activeId="saved" onOpen={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onPin={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chat actions" }));
    const menu = screen.getByRole("menu", { name: "Chat actions" });
    expect(Number.parseFloat(menu.style.maxHeight)).toBeLessThan(90);
    fireEvent.scroll(menu);
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });
  it("offers pinning for saved chats and prevents deleting a pending transaction's chat", () => {
    const onPin = vi.fn(), onDelete = vi.fn();
    const props = { hasWallet: true, healthFactor: null, positions: [], activeId: "saved",
      conversations: [{ id: "saved", title: "Important plan", createdAt: 1, updatedAt: 1, pending: true }],
      onOpen: vi.fn(), onRename: vi.fn(), onDelete, onPin };
    const { rerender } = render(<CopilotRailBody {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Chat actions" }));
    expect((screen.getByRole("menuitem", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin chat" }));
    expect(onPin).toHaveBeenCalledWith("saved", true);
    expect(onDelete).not.toHaveBeenCalled();
    rerender(<CopilotRailBody {...props} conversations={[{ ...props.conversations[0], pinned: true }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Chat actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin chat" }));
    expect(onPin).toHaveBeenLastCalledWith("saved", false);
  });
  it("does not describe a loading or failed account read as an empty portfolio", () => {
    const props = { hasWallet: true, healthFactor: null, positions: [], conversations: [], activeId: null, onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetryAccount: vi.fn() };
    const { rerender } = render(<CopilotRailBody {...props} accountLoading />);
    // Position lists start closed (owner, 22 Oct); open the margin one to read it.
    expect(screen.queryByText("Loading positions…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Margin Positions/ }));
    expect(screen.getByText("Loading positions…")).toBeTruthy();
    expect(screen.queryByText("Nothing open.")).toBeNull();
    rerender(<CopilotRailBody {...props} accountError />);
    expect(screen.getByText("Positions unavailable.")).toBeTruthy();
    expect(screen.queryByText("Nothing open.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry account data" }));
    expect(props.onRetryAccount).toHaveBeenCalledTimes(1);
    rerender(<CopilotRailBody {...props} />);
    expect(screen.getByText("Nothing open.")).toBeTruthy();
  });

  it("keeps loaded positions visible and labels them when a refresh fails", () => {
    render(<CopilotRailBody hasWallet healthFactor={3} accountError positions={[{ symbol: "XLM", role: "Margin · Collateral", amount: "23.5", usd: "$4.70" }]} conversations={[]} activeId={null} onOpen={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Margin Positions/ }));
    expect(screen.getByText("23.5")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("previously loaded");
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });
  it("updates the health value without replacing conversation controls or inventing a direction label", () => {
    const props = { hasWallet: true, positions: [], conversations: [], activeId: null, onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() };
    const { rerender } = render(<CopilotRailBody {...props} healthFactor={3} />);
    const positions = screen.getByRole("button", { name: "Margin Positions" });
    expect(screen.getByText("3.00")).toBeTruthy();
    rerender(<CopilotRailBody {...props} healthFactor={1.8} />);
    expect(screen.getByText("1.80")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Margin Positions" })).toBe(positions);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("previews positions on hover, pins on click, and retains the account's figures", () => {
    vi.useFakeTimers();
    render(<CopilotRailPresentation.Provider value><p>Server explanation above the card</p><CopilotRailBody hasWallet healthFactor={999} positions={[{ symbol: "XLM", role: "Margin · Collateral", amount: "23.5", usd: "$4.70" }]} conversations={[]} activeId={null} onOpen={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} /></CopilotRailPresentation.Provider>);
    const trigger = screen.getByRole("button", { name: "Margin Positions" });
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("dialog", { name: "Margin Positions" })).toBeTruthy();
    expect(screen.getByText("23.5")).toBeTruthy();
    expect(screen.getByText("$4.70")).toBeTruthy();
    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("dialog", { name: "Margin Positions" })).toBeNull();
    fireEvent.mouseEnter(trigger);
    fireEvent.click(trigger);
    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("dialog", { name: "Margin Positions" })).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog", { name: "Margin Positions" })).toBeNull();
    expect(screen.getByText("Server explanation above the card")).toBeTruthy();
    expect(screen.getByText("∞")).toBeTruthy();
  });

  it("lists Earn deposits in their own section, apart from margin positions", () => {
    render(<CopilotRailBody hasWallet healthFactor={3} positions={[{ symbol: "XLM", role: "Margin · Collateral", amount: "23.5", usd: "$4.70" }]} earnPositions={[{ symbol: "BLUSDC", role: "Earn · Supplied", amount: "10", usd: "$10.00" }]} conversations={[]} activeId={null} onOpen={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Margin Positions/ })).toBeTruthy();
    // Both start closed; each opens on its own.
    expect(screen.queryByText("BLUSDC")).toBeNull();
    expect(screen.queryByText("23.5")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Earn Positions/ }));
    expect(screen.getByText("BLUSDC")).toBeTruthy();
    expect(screen.getByText("Earn · Supplied")).toBeTruthy();
    expect(screen.queryByText("23.5")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Margin Positions/ }));
    expect(screen.getByText("23.5")).toBeTruthy();
  });

  it("keeps the same budget controls open after toggling and forwards custom values unchanged", () => {
    const props: AutoApproveMenuProps = { on: false, variant: "rail", capsMode: "defaults", customTx: "250", customDay: "3000", defaultTx: 1000, defaultDay: 5000, onToggle: vi.fn(), onCapsMode: vi.fn(), onCustomTx: vi.fn(), onCustomDay: vi.fn() };
    const view = (updated: AutoApproveMenuProps) => <CopilotRailPresentation.Provider value><AutoApproveMenu {...updated} /></CopilotRailPresentation.Provider>;
    const { rerender } = render(view(props));
    const trigger = screen.getByRole("button", { name: "Auto-approve off" });
    fireEvent.mouseEnter(trigger);
    fireEvent.click(trigger);
    expect((screen.getByLabelText(/Default per day cap/) as HTMLInputElement).value).toBe("5000");
    fireEvent.click(screen.getByRole("switch"));
    expect(props.onToggle).toHaveBeenCalledTimes(1);
    rerender(view({ ...props, on: true }));
    expect(screen.getByRole("dialog", { name: "Auto-approve" })).toBeTruthy();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(props.onCapsMode).toHaveBeenCalledWith("custom");
    rerender(view({ ...props, on: true, capsMode: "custom" }));
    fireEvent.change(screen.getByLabelText(/Per transaction cap/) , { target: { value: "275.5" } });
    expect(props.onCustomTx).toHaveBeenCalledWith("275.5");
    expect(props.onCustomDay).not.toHaveBeenCalled();
  });
});
