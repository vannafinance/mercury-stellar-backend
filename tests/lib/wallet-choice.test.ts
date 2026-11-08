// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useUserStore } from "@/store/user";
import { WalletService } from "@/lib/stellar-utils";
import { useWallet } from "@/hooks/use-wallet";
import { readWalletChoice, WALLET_CHOICE_KEY, writeWalletChoice } from "@/lib/wallet-choice";

/**
 * 26 Oct, live (local and deployed): after Disconnect, a hard reload connected Freighter again (the extension is already
 * authorised for the site), and a Privy login, which returns through a full-page redirect, ended up on Freighter because the
 * passive Freighter check answered before Privy finished. Wallet state is memory-only, so nothing remembered the choice.
 * The last EXPLICIT choice (a click on Connect or Disconnect) is kept; the passive check never writes it.
 */
vi.mock("@/lib/stellar-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar-utils")>();
  return {
    ...actual,
    WalletService: { ...actual.WalletService, checkConnection: vi.fn(), connectWallet: vi.fn() },
    ContractService: {
      ...actual.ContractService,
      getAllTokenBalances: vi.fn().mockResolvedValue({ XLM: "1", USDC: "0", BLEND_USDC: "0", AQUARIUS_USDC: "0", SOROSWAP_USDC: "0" }),
      getDepositedBalance: vi.fn().mockResolvedValue("0"),
    },
  };
});
vi.mock("@/contexts/ledger-subscriber", () => ({ useLedgerTick: () => ({ tick: 0 }) }));
vi.mock("@/lib/privy-session", () => ({ hasUnexpiredPrivySession: () => false }));

const FREIGHTER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

describe("the stored wallet choice", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips the three values and ignores anything else", () => {
    expect(readWalletChoice()).toBeNull();
    for (const choice of ["privy", "freighter", "none"] as const) {
      writeWalletChoice(choice);
      expect(readWalletChoice()).toBe(choice);
    }
    localStorage.setItem(WALLET_CHOICE_KEY, "metamask");
    expect(readWalletChoice()).toBeNull();
  });

  it("never throws when storage is blocked", () => {
    const blocked = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const failing = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(readWalletChoice()).toBeNull();
    expect(() => writeWalletChoice("none")).not.toThrow();
    blocked.mockRestore();
    failing.mockRestore();
  });
});

describe("the reload check honours the last explicit choice", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useUserStore.getState().set({ address: null, isConnected: false, walletKind: null, manuallyDisconnected: false });
    vi.mocked(WalletService.checkConnection).mockResolvedValue({ address: FREIGHTER, connected: true });
  });
  afterEach(() => localStorage.clear());

  const reload = async () => {
    renderHook(() => useWallet());
    await act(async () => { window.dispatchEvent(new Event("focus")); });
  };

  it("does not reconnect an authorised Freighter after the user disconnected", async () => {
    writeWalletChoice("none");
    await reload();
    expect(WalletService.checkConnection).not.toHaveBeenCalled();
    expect(useUserStore.getState().isConnected).toBe(false);
  });

  it("does not let the Freighter extension answer first when the user chose Privy", async () => {
    writeWalletChoice("privy");
    await reload();
    expect(WalletService.checkConnection).not.toHaveBeenCalled();
    expect(useUserStore.getState().walletKind).not.toBe("freighter");
  });

  it("still reconnects Freighter after a reload when that was the choice, and on a first visit with no choice", async () => {
    writeWalletChoice("freighter");
    await reload();
    expect(useUserStore.getState()).toMatchObject({ isConnected: true, walletKind: "freighter", address: FREIGHTER });

    localStorage.clear();
    useUserStore.getState().set({ address: null, isConnected: false, walletKind: null });
    await reload();
    expect(useUserStore.getState()).toMatchObject({ isConnected: true, walletKind: "freighter" });
    expect(readWalletChoice()).toBeNull(); // the passive check never records a choice
  });

  it("records Disconnect and an explicit Freighter connect", async () => {
    vi.mocked(WalletService.connectWallet).mockResolvedValue({ success: true, address: FREIGHTER } as never);
    const { result } = renderHook(() => useWallet());
    await act(async () => { await result.current.connectWallet("freighter"); });
    expect(readWalletChoice()).toBe("freighter");
    await act(async () => { result.current.disconnectWallet(); });
    expect(readWalletChoice()).toBe("none");
  });
});
