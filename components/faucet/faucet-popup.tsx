"use client";

/**
 * Mainnet: faucet is disabled. Kept as a no-op component so any residual
 * imports do not break the build. Fund wallets via exchange / bridge.
 */

interface FaucetPopupProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string | null;
}

export function FaucetPopup(_props: FaucetPopupProps) {
  return null;
}
