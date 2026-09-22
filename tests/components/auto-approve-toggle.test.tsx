// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AutoApproveMenu } from "@/components/copilot/auto-approve-menu";
import { setAutoApprove, useCopilotSettingsStore } from "@/store/copilot-settings";

describe("AutoApproveMenu — optimistic toggle and immediate UI synchronization", () => {
  it("renders 'On' and aria-checked='true' when on is true", () => {
    render(
      <AutoApproveMenu
        on={true}
        variant="rail"
        capsMode="defaults"
        customTx="500"
        customDay="2000"
        defaultTx={1000}
        defaultDay={1000}
        onToggle={vi.fn()}
        onCapsMode={vi.fn()}
        onCustomTx={vi.fn()}
        onCustomDay={vi.fn()}
      />,
    );

    expect(screen.getByText("Auto-approve")).toBeTruthy();
    expect(screen.getByText("On")).toBeTruthy();
  });

  it("renders 'Off' when on is false", () => {
    render(
      <AutoApproveMenu
        on={false}
        variant="rail"
        capsMode="defaults"
        customTx="500"
        customDay="2000"
        defaultTx={1000}
        defaultDay={1000}
        onToggle={vi.fn()}
        onCapsMode={vi.fn()}
        onCustomTx={vi.fn()}
        onCustomDay={vi.fn()}
      />,
    );

    expect(screen.getByText("Off")).toBeTruthy();
  });

  it("invokes onToggle immediately when switch button in panel is clicked", () => {
    const handleToggle = vi.fn();
    render(
      <AutoApproveMenu
        on={false}
        variant="rail"
        capsMode="defaults"
        customTx="500"
        customDay="2000"
        defaultTx={1000}
        defaultDay={1000}
        onToggle={handleToggle}
        onCapsMode={vi.fn()}
        onCustomTx={vi.fn()}
        onCustomDay={vi.fn()}
      />,
    );

    // Open flyout
    const trigger = screen.getByRole("button", { name: /Auto-approve/i });
    fireEvent.click(trigger);

    // Switch should be visible and not busy
    const switchBtn = screen.getByRole("switch");
    expect(switchBtn.getAttribute("aria-checked")).toBe("false");
    expect(switchBtn.hasAttribute("disabled")).toBe(false);

    fireEvent.click(switchBtn);
    expect(handleToggle).toHaveBeenCalledTimes(1);
  });

  it("disables switch when busy is true to prevent duplicate triggers", () => {
    const handleToggle = vi.fn();
    render(
      <AutoApproveMenu
        on={true}
        busy={true}
        variant="rail"
        capsMode="defaults"
        customTx="500"
        customDay="2000"
        defaultTx={1000}
        defaultDay={1000}
        onToggle={handleToggle}
        onCapsMode={vi.fn()}
        onCustomTx={vi.fn()}
        onCustomDay={vi.fn()}
      />,
    );

    // Open flyout
    const trigger = screen.getByRole("button", { name: /Auto-approve/i });
    fireEvent.click(trigger);

    const switchBtn = screen.getByRole("switch");
    expect(switchBtn.hasAttribute("disabled")).toBe(true);

    fireEvent.click(switchBtn);
    expect(handleToggle).not.toHaveBeenCalled();
  });

  it("updates store immediately with setAutoApprove", () => {
    const testWallet = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(useCopilotSettingsStore.getState().autoApproveByWallet[testWallet]).toBeFalsy();

    setAutoApprove(testWallet, true);
    expect(useCopilotSettingsStore.getState().autoApproveByWallet[testWallet]).toBe(true);

    setAutoApprove(testWallet, false);
    expect(useCopilotSettingsStore.getState().autoApproveByWallet[testWallet]).toBe(false);
  });
});
