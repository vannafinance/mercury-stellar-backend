import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract tests for the GET /api/account/[addr] route handler.
 *
 * The snapshot math itself lives in tests for computeMarginSnapshot/
 * deriveMarginHealth. These tests pin the handler's own responsibilities:
 *   • input validation (short/empty addr → 400 no-store)
 *   • address routing: C-address used directly, G-address resolved via discovery
 *   • the { hasMarginAccount, ...snapshot } success shape + CACHE header
 *   • the no-account (200 hasMarginAccount:false) and 502 error contracts
 */
const mocks = vi.hoisted(() => ({
  discoverExistingAccount: vi.fn(),
  computeMarginSnapshot: vi.fn(),
}));

vi.mock("@/lib/margin-utils", () => ({
  MarginAccountService: { discoverExistingAccount: mocks.discoverExistingAccount },
}));
vi.mock("@/lib/account-snapshot", () => ({
  computeMarginSnapshot: mocks.computeMarginSnapshot,
}));

import { GET } from "@/app/api/account/[addr]/route";

const CACHE = "public, s-maxage=15, stale-while-revalidate=60";
const C_ADDR = "C".padEnd(56, "A"); // margin account address
const G_ADDR = "G".padEnd(56, "B"); // user wallet address

const call = (addr: string) =>
  GET(new Request("http://test/api/account"), { params: Promise.resolve({ addr }) });

const snapshot = () => ({
  borrowedBalances: {},
  collateralBalances: { XLM: { amount: "100", usdValue: "12.00" } },
  totalBorrowedValue: 0,
  totalCollateralValue: 12,
  grossCollateralValue: 12,
  totalValue: 12,
  avgHealthFactor: 0,
  collateralLeftBeforeLiquidation: 12,
  netAvailableCollateral: 12,
  borrowRate: 0,
  debtLimit: 10.9,
});

describe("GET /api/account/[addr]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("400 invalid_address (no-store) for empty / too-short addresses", async () => {
    for (const bad of ["", "G", "short"]) {
      const res = await call(bad);
      expect(res.status).toBe(400);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect((await res.json()).error).toBe("invalid_address");
    }
    // never touches the chain on bad input
    expect(mocks.discoverExistingAccount).not.toHaveBeenCalled();
    expect(mocks.computeMarginSnapshot).not.toHaveBeenCalled();
  });

  it("C-address is used directly (no discovery) → 200 snapshot + cache header", async () => {
    const snap = snapshot();
    mocks.computeMarginSnapshot.mockResolvedValue(snap);

    const res = await call(C_ADDR);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
    expect(mocks.discoverExistingAccount).not.toHaveBeenCalled();
    expect(mocks.computeMarginSnapshot).toHaveBeenCalledWith(C_ADDR);

    const body = await res.json();
    expect(body).toMatchObject({
      hasMarginAccount: true,
      marginAccountAddress: C_ADDR,
      ...snap,
    });
  });

  it("G-address is resolved through discoverExistingAccount", async () => {
    mocks.discoverExistingAccount.mockResolvedValue(C_ADDR);
    mocks.computeMarginSnapshot.mockResolvedValue(snapshot());

    const res = await call(G_ADDR);
    expect(res.status).toBe(200);
    expect(mocks.discoverExistingAccount).toHaveBeenCalledWith(G_ADDR);
    // the snapshot runs against the *resolved* margin account, not the G-address
    expect(mocks.computeMarginSnapshot).toHaveBeenCalledWith(C_ADDR);
    expect((await res.json()).marginAccountAddress).toBe(C_ADDR);
  });

  it("G-address with no margin account → 200 { hasMarginAccount:false } (cacheable)", async () => {
    mocks.discoverExistingAccount.mockResolvedValue(null);

    const res = await call(G_ADDR);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
    expect(mocks.computeMarginSnapshot).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ hasMarginAccount: false });
  });

  it("502 snapshot_failed (no-store) when the snapshot throws", async () => {
    mocks.computeMarginSnapshot.mockRejectedValue(new Error("ledger unavailable"));

    const res = await call(C_ADDR);
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = await res.json();
    expect(body.error).toBe("snapshot_failed");
    expect(body.detail).toBe("ledger unavailable");
  });

  it("502 detail falls back to a string when a non-Error is thrown", async () => {
    mocks.discoverExistingAccount.mockRejectedValue("kaboom");
    const res = await call(G_ADDR);
    expect(res.status).toBe(502);
    expect((await res.json()).detail).toBe("snapshot failed");
  });
});
