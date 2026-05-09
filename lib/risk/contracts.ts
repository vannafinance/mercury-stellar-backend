/** Chain metadata for copied risk UI (EVM ids + Stellar sentinel). */

export const CHAIN_NAMES: Record<number, string> = {
  0: "Stellar",
  1: "Ethereum",
  10: "Optimism",
  8453: "Base",
  42161: "Arbitrum One",
};

export const CHAIN_COLORS: Record<number, string> = {
  0: "#7C3AED",
  1: "#627EEA",
  10: "#FF0420",
  8453: "#0052FF",
  42161: "#28A0F0",
};

export const SUPPORTED_CHAINS: readonly number[] = [8453, 42161, 10, 1];
