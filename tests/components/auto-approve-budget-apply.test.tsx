// @vitest-environment happy-dom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoApproveMenu, type AutoApproveMenuProps } from "@/components/copilot/auto-approve-menu";
afterEach(cleanup);
const props = (): AutoApproveMenuProps => ({ on: true, capsMode: "custom", customTx: "3000", customDay: "5000",
  defaultTx: 1000, defaultDay: 5000, capUnit: "testnet_usd", maximumDay: 5000,
  activeLimits: "$1000 per transaction · $5000 per day", draftChanged: true,
  onToggle: vi.fn(), onCapsMode: vi.fn(), onCustomTx: vi.fn(), onCustomDay: vi.fn(), onApplyLimits: vi.fn() });
describe("active auto-approve policy editing", () => {
  it("keeps the Auto-approve name, disables Freighter activation and explains manual signing", () => {
    const p = props(); render(<AutoApproveMenu {...p} walletSigningRequired />);
    fireEvent.click(screen.getByRole("button", { name: /Auto-approve/ }));
    expect(screen.getByRole("dialog", { name: "Auto-approve" })).toBeTruthy();
    const toggle = screen.getByRole("switch");
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Auto-approve is available with Privy wallets/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Custom" })).toBeNull();
    fireEvent.click(toggle); expect(p.onToggle).not.toHaveBeenCalled();
  });
  it("opens an externally requested settings review without invoking Apply or the signing toggle", () => {
    const p = props(); render(<AutoApproveMenu {...p} reviewRequest={1} />);
    expect(screen.getByRole("dialog", { name: "Auto-approve" })).toBeTruthy();
    expect(screen.getByLabelText("Per transaction cap in testnet USD").getAttribute("value")).toBe("3000");
    expect(p.onApplyLimits).not.toHaveBeenCalled();
    expect(p.onToggle).not.toHaveBeenCalled();
  });
  it("keeps On and the accepted limits visible while editing, and applies only on the explicit gesture", () => {
    const p = props(); render(<AutoApproveMenu {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /Auto-approve/ }));
    fireEvent.change(screen.getByLabelText("Per transaction cap in testnet USD"), { target: { value: "2000" } });
    expect(p.onApplyLimits).not.toHaveBeenCalled();
    expect(screen.getByText(/Active: \$1000/)).toBeTruthy();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Apply limits" }));
    expect(p.onApplyLimits).toHaveBeenCalledOnce();
    expect(p.onToggle).not.toHaveBeenCalled();
  });
  it("prevents invalid or duplicate policy applies and places the independent maximum only on the daily field", () => {
    const p = props(); render(<AutoApproveMenu {...p} draftError="Daily limit cannot exceed $5000." />);
    fireEvent.click(screen.getByRole("button", { name: /Auto-approve/ }));
    expect(screen.getByRole("button", { name: "Apply limits" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Per transaction cap in testnet USD").getAttribute("max")).toBeNull();
    expect(screen.getByLabelText("Per day cap in testnet USD").getAttribute("max")).toBe("5000");
    fireEvent.click(screen.getByRole("button", { name: "Apply limits" }));
    expect(p.onApplyLimits).not.toHaveBeenCalled();
  });
});
