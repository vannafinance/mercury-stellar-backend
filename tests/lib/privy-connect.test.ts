import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getActiveWalletKind,
  registerPrivyAuthControls,
  startPrivyConnect,
  type PrivyConnectResult,
} from "@/lib/wallet-adapter";

function controls(
  over: Partial<{
    login: () => void;
    authenticated: boolean;
    resync: () => boolean;
  }> = {},
) {
  return {
    login: over.login ?? vi.fn(),
    logout: vi.fn(async () => {}),
    authenticated: over.authenticated ?? false,
    resync: over.resync ?? vi.fn(() => false),
    getAccessToken: vi.fn(async () => null),
    authorizeVannaSigner: vi.fn(async () => ({ address: "GTEST", delegated: false })),
  };
}

describe("startPrivyConnect", () => {
  afterEach(() => {
    registerPrivyAuthControls(null);
  });

  it("returns unavailable when the Privy bridge has not registered", () => {
    expect(startPrivyConnect()).toBe("unavailable" satisfies PrivyConnectResult);
  });

  it("opens Privy login when there is no session", () => {
    const login = vi.fn();
    registerPrivyAuthControls(controls({ login, authenticated: false }));
    expect(startPrivyConnect()).toBe("login");
    expect(login).toHaveBeenCalledTimes(1);
    expect(getActiveWalletKind()).toBe("privy");
  });

  it("resyncs instead of login when Privy already has a live session", () => {
    const login = vi.fn();
    const resync = vi.fn(() => true);
    registerPrivyAuthControls(controls({ login, authenticated: true, resync }));
    expect(startPrivyConnect()).toBe("resync");
    expect(login).not.toHaveBeenCalled();
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it("does not call login when authenticated but the Stellar wallet is still being created", () => {
    const login = vi.fn();
    registerPrivyAuthControls(controls({ login, authenticated: true, resync: () => false }));
    expect(startPrivyConnect()).toBe("pending-wallet");
    expect(login).not.toHaveBeenCalled();
  });
});
