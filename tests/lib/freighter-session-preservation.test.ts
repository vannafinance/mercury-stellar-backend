// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useUserStore } from "@/store/user";
import { WalletService } from "@/lib/stellar-utils";
import { useWallet } from "@/hooks/use-wallet";

vi.mock("@/lib/stellar-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar-utils")>();
  return {
    ...actual,
    WalletService: {
      ...actual.WalletService,
      checkConnection: vi.fn(),
      connectWallet: vi.fn(),
    },
    ContractService: {
      ...actual.ContractService,
      getAllTokenBalances: vi.fn().mockResolvedValue({
        XLM: "100",
        USDC: "50",
        BLEND_USDC: "0",
        AQUARIUS_USDC: "0",
        SOROSWAP_USDC: "0",
      }),
      getDepositedBalance: vi.fn().mockResolvedValue("0"),
    },
  };
});

vi.mock("@/contexts/ledger-subscriber", () => ({
  useLedgerTick: () => ({ tick: 0 }),
}));

vi.mock("@/lib/privy-session", () => ({
  hasUnexpiredPrivySession: () => false,
}));

describe("Freighter wallet connection preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUserStore.getState().set({
      address: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      isConnected: true,
      walletKind: "freighter",
      manuallyDisconnected: false,
    });
  });

  it("does not wipe active Freighter session if background checkConnection momentarily fails", async () => {
    // Simulate Freighter extension temporarily busy or returning connected=false on focus
    vi.mocked(WalletService.checkConnection).mockResolvedValue({ address: "", connected: false });

    renderHook(() => useWallet());

    // Trigger window focus event as happens when user approves a transaction in Freighter popup
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    const state = useUserStore.getState();
    expect(state.isConnected).toBe(true);
    expect(state.walletKind).toBe("freighter");
    expect(state.address).toBe("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H");
  });

  it("updates address if Freighter confirms a new address", async () => {
    const newAddress = "GCOVVKFNCV5S3QY5B4Q7G6L5W2M7C4Z4B7E5D3T2A1P0X9Y8Z7W6V5U4";
    vi.mocked(WalletService.checkConnection).mockResolvedValue({ address: newAddress, connected: true });

    renderHook(() => useWallet());

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    const state = useUserStore.getState();
    expect(state.isConnected).toBe(true);
    expect(state.address).toBe(newAddress);
  });
});
