// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CopilotRailPresentation } from "@/components/copilot/copilot-shell";
import { CopilotRailBody } from "@/components/copilot/copilot-rail";
import { AutoApproveMenu, type AutoApproveMenuProps } from "@/components/copilot/auto-approve-menu";

afterEach(() => vi.useRealTimers());

describe("compact rail presentation", () => {
  it("does not describe a loading or failed account read as an empty portfolio", () => {
    const props = { hasWallet: true, healthFactor: null, positions: [], conversations: [], activeId: null, onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetryAccount: vi.fn() };
    const { rerender } = render(<CopilotRailBody {...props} accountLoading />);
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
    expect(screen.getByText("23.5")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("previously loaded");
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });
  it("updates the health value without replacing conversation controls or inventing a direction label", () => {
    const props = { hasWallet: true, positions: [], conversations: [], activeId: null, onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() };
    const { rerender } = render(<CopilotRailBody {...props} healthFactor={3} />);
    const positions = screen.getByRole("button", { name: "Positions" });
    expect(screen.getByText("3.00")).toBeTruthy();
    rerender(<CopilotRailBody {...props} healthFactor={1.8} />);
    expect(screen.getByText("1.80")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Positions" })).toBe(positions);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("previews positions on hover, pins on click, and retains the account's figures", () => {
    vi.useFakeTimers();
    render(<CopilotRailPresentation.Provider value><p>Server explanation above the card</p><CopilotRailBody hasWallet healthFactor={999} positions={[{ symbol: "XLM", role: "Margin · Collateral", amount: "23.5", usd: "$4.70" }]} conversations={[]} activeId={null} onOpen={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} /></CopilotRailPresentation.Provider>);
    const trigger = screen.getByRole("button", { name: "Positions" });
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("dialog", { name: "Positions" })).toBeTruthy();
    expect(screen.getByText("23.5")).toBeTruthy();
    expect(screen.getByText("$4.70")).toBeTruthy();
    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("dialog", { name: "Positions" })).toBeNull();
    fireEvent.mouseEnter(trigger);
    fireEvent.click(trigger);
    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("dialog", { name: "Positions" })).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog", { name: "Positions" })).toBeNull();
    expect(screen.getByText("Server explanation above the card")).toBeTruthy();
    expect(screen.getByText("∞")).toBeTruthy();
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
