import { beforeEach, describe, expect, it, vi } from "vitest";
const freighter = vi.hoisted(() => ({ getAddress: vi.fn(), isAllowed: vi.fn(), requestAccess: vi.fn(), signTransaction: vi.fn(), signMessage: vi.fn() }));
vi.mock("@stellar/freighter-api", () => freighter);
import { getPrivyIdentityToken, registerPrivyAuthControls, setActiveWalletKind, signMessage, signTransaction } from "@/lib/wallet-adapter";
describe("Freighter authorization and wallet selection", () => {
  beforeEach(() => {
    vi.clearAllMocks(); setActiveWalletKind("freighter"); registerPrivyAuthControls(null);
    freighter.getAddress.mockResolvedValue({ address: "selected-wallet" });
    freighter.isAllowed.mockResolvedValue({ isAllowed: false });
    freighter.requestAccess.mockResolvedValue({ address: "selected-wallet" });
    freighter.signMessage.mockResolvedValue({ signedMessage: "signature", signerAddress: "selected-wallet" });
  });
  it("requests site authorization before proving a displayed but unauthorized wallet", async () => {
    await signMessage("ownership challenge", { address: "selected-wallet" });
    expect(freighter.requestAccess).toHaveBeenCalledTimes(1);
    expect(freighter.signMessage).toHaveBeenCalledWith("ownership challenge", { address: "selected-wallet" });
  });
  it("does not sign a transaction for an account that changed during connection", async () => {
    freighter.requestAccess.mockResolvedValue({ address: "another-wallet" });
    expect((await signTransaction("unsigned-xdr", { address: "selected-wallet", networkPassphrase: "testnet" })).error).toBeTruthy();
    expect(freighter.signTransaction).not.toHaveBeenCalled();
  });
  it("does not sign the ownership challenge after the selected account changes", async () => {
    freighter.isAllowed.mockResolvedValue({ isAllowed: true });
    expect((await signMessage("challenge", { address: "another-wallet" })).error).toBeTruthy();
    expect(freighter.signMessage).not.toHaveBeenCalled();
  });
  it("does not attach an authenticated Privy identity to the selected Freighter wallet", async () => {
    const getAccessToken = vi.fn(async () => "privy-token");
    registerPrivyAuthControls({ authenticated: true, ready: true, getAccessToken, login: vi.fn(), logout: vi.fn(), resync: vi.fn(), authorizeVannaSigner: vi.fn() });
    expect(await getPrivyIdentityToken()).toBeNull(); expect(getAccessToken).not.toHaveBeenCalled();
    setActiveWalletKind("privy"); expect(await getPrivyIdentityToken()).toBe("privy-token");
  });
});
