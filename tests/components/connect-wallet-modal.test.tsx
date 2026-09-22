// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConnectWalletModal } from "@/components/wallet/connect-wallet-modal";
import { ThemeProvider } from "@/contexts/theme-context";

function renderModal(
  over: Partial<{
    privyEnabled: boolean;
    isLoading: boolean;
  }> = {},
) {
  const onSelectPrivy = vi.fn();
  const onSelectFreighter = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <ThemeProvider>
      <ConnectWalletModal
        isOpen
        onClose={onClose}
        onSelectFreighter={onSelectFreighter}
        onSelectPrivy={onSelectPrivy}
        privyEnabled
        {...over}
      />
    </ThemeProvider>,
  );
  return { ...view, onSelectPrivy, onSelectFreighter, onClose };
}

describe("ConnectWalletModal", () => {
  it("Create Vanna wallet click fires onSelectPrivy", async () => {
    const { onSelectPrivy, onSelectFreighter } = renderModal();
    const button = await screen.findByRole("button", { name: /Create Vanna wallet/i });
    fireEvent.click(button);
    expect(onSelectPrivy).toHaveBeenCalledTimes(1);
    expect(onSelectFreighter).not.toHaveBeenCalled();
  });

  it("portals the dialog to document.body so navbar zoom cannot eat the click", async () => {
    const { container } = renderModal();
    const dialog = await screen.findByRole("dialog", { name: /Connect a wallet/i });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });
});
