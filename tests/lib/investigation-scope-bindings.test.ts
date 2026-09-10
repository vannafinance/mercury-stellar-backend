import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discoverExistingAccount: vi.fn(),
}));

vi.mock("@/lib/margin-utils", () => ({
  MarginAccountService: {
    discoverExistingAccount: mocks.discoverExistingAccount,
  },
}));

const {
  resolveInvestigationScope,
  resetInvestigationScopeCache,
  ResearchError,
  SCOPE_CACHE_TTL_MS,
} = await import("@/lib/copilot/investigation/scope");

const SUBJECT = "user_sub";
const WALLET = "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5";
const OTHER = "GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52";
const ACCOUNT = "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C";

function bindingsOk(wallets: string[]) {
  return {
    has_assertion: true,
    sub: SUBJECT,
    bindings: wallets.map((walletAddress) => ({ walletAddress, status: "active" })),
  };
}

beforeEach(() => {
  resetInvestigationScopeCache();
  mocks.discoverExistingAccount.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("investigation scope bindings", () => {
  it("does not accuse a wallet of being unlinked when bindings come back empty", async () => {
    const mcp = {
      call: vi.fn(async () => ({ has_assertion: true, sub: SUBJECT, bindings: [] })),
    };
    const scope = await resolveInvestigationScope(
      { subject: SUBJECT, wallet: WALLET, network: "testnet" },
      mcp,
      new AbortController().signal,
    );
    expect(scope).toMatchObject({
      subject: SUBJECT, trader: null, smartAccount: null, unverified: "bindings",
    });
    expect(mcp.call).toHaveBeenCalledTimes(2);
  });

  it("retries an empty list and accepts a later non-empty binding", async () => {
    const mcp = {
      call: vi.fn(async (tool: string) => {
        if (tool === "vanna_list_my_wallet_bindings") {
          return mcp.call.mock.calls.filter(([name]) => name === "vanna_list_my_wallet_bindings").length === 1
            ? { has_assertion: true, sub: SUBJECT, bindings: [] }
            : bindingsOk([WALLET]);
        }
        if (tool === "vanna_resolve_account") {
          return { status: "found_on_chain", smart_account: ACCOUNT };
        }
        throw new Error(tool);
      }),
    };
    const scope = await resolveInvestigationScope(
      { subject: SUBJECT, wallet: WALLET, network: "testnet" },
      mcp,
      new AbortController().signal,
    );
    expect(scope).toEqual({
      subject: SUBJECT, trader: WALLET, smartAccount: ACCOUNT, network: "testnet",
    });
  });

  it("only claims not-linked from a non-empty list that lacks this wallet", async () => {
    const mcp = { call: vi.fn(async () => bindingsOk([OTHER])) };
    await expect(resolveInvestigationScope(
      { subject: SUBJECT, wallet: WALLET, network: "testnet" },
      mcp,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "wallet_not_bound" });
    expect(mcp.call).toHaveBeenCalledTimes(1);
  });

  it("accepts wallet_address on a binding row", async () => {
    const mcp = {
      call: vi.fn(async (tool: string) => {
        if (tool === "vanna_list_my_wallet_bindings") {
          return {
            has_assertion: true,
            sub: SUBJECT,
            bindings: [{ wallet_address: WALLET, status: "active" }],
          };
        }
        return { status: "found_on_chain", smart_account: ACCOUNT };
      }),
    };
    const scope = await resolveInvestigationScope(
      { subject: SUBJECT, wallet: WALLET, network: "testnet" },
      mcp,
      new AbortController().signal,
    );
    expect(scope.trader).toBe(WALLET);
    expect(scope.smartAccount).toBe(ACCOUNT);
  });

  it("falls back to on-chain discovery when MCP resolve errors", async () => {
    mocks.discoverExistingAccount.mockResolvedValue(ACCOUNT);
    const mcp = {
      call: vi.fn(async (tool: string) => {
        if (tool === "vanna_list_my_wallet_bindings") return bindingsOk([WALLET]);
        return { error: "timeout" };
      }),
    };
    const scope = await resolveInvestigationScope(
      { subject: SUBJECT, wallet: WALLET, network: "testnet" },
      mcp,
      new AbortController().signal,
    );
    expect(scope.smartAccount).toBe(ACCOUNT);
    expect(mocks.discoverExistingAccount).toHaveBeenCalledWith(WALLET);
  });

  it("caches a verified scope for five minutes so the next prompt skips both MCP hops", async () => {
    const mcp = {
      call: vi.fn(async (tool: string) => {
        if (tool === "vanna_list_my_wallet_bindings") return bindingsOk([WALLET]);
        return { status: "found_on_chain", smart_account: ACCOUNT };
      }),
    };
    const input = { subject: SUBJECT, wallet: WALLET, network: "testnet" as const };
    const first = await resolveInvestigationScope(input, mcp, new AbortController().signal);
    const second = await resolveInvestigationScope(input, mcp, new AbortController().signal);
    expect(second).toEqual(first);
    expect(mcp.call).toHaveBeenCalledTimes(2);
    expect(console.info).toHaveBeenCalledWith(
      "[copilot] investigation phase",
      expect.objectContaining({ phase: "scope_cache", hit: true }),
    );
  });

  it("does not cache an unverified public fallback", async () => {
    const mcp = {
      call: vi.fn(async () => ({ has_assertion: true, sub: SUBJECT, bindings: [] })),
    };
    const input = { subject: SUBJECT, wallet: WALLET, network: "testnet" as const };
    await resolveInvestigationScope(input, mcp, new AbortController().signal);
    await resolveInvestigationScope(input, mcp, new AbortController().signal);
    expect(mcp.call.mock.calls.length).toBeGreaterThan(2);
  });

  it("expires the cache after five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T08:00:00Z"));
    const mcp = {
      call: vi.fn(async (tool: string) => {
        if (tool === "vanna_list_my_wallet_bindings") return bindingsOk([WALLET]);
        return { status: "found_on_chain", smart_account: ACCOUNT };
      }),
    };
    const input = { subject: SUBJECT, wallet: WALLET, network: "testnet" as const };
    await resolveInvestigationScope(input, mcp, new AbortController().signal);
    vi.setSystemTime(new Date("2026-09-10T08:00:00Z").getTime() + SCOPE_CACHE_TTL_MS + 1);
    await resolveInvestigationScope(input, mcp, new AbortController().signal);
    expect(mcp.call.mock.calls.length).toBe(4);
    vi.useRealTimers();
  });

  it("still throws ResearchError for a genuinely unbound wallet", async () => {
    const mcp = { call: vi.fn(async () => bindingsOk([OTHER])) };
    await expect(resolveInvestigationScope(
      { subject: SUBJECT, wallet: WALLET, network: "testnet" },
      mcp,
      new AbortController().signal,
    )).rejects.toBeInstanceOf(ResearchError);
  });
});
