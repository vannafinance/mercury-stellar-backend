import { describe, it, expect, vi, afterEach } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

import { maxSpendableXlm, XLM_FEE_BUFFER, getXlmMinReserve } from "@/lib/xlm-reserve";

/**
 * Verifies the native-XLM spendable-balance math that gates deposits.
 *
 * Regression context: a near-MAX XLM deposit previously reserved a flat 0.5 XLM,
 * dropping the wallet below its real minimum balance ((2 + subentries) × 0.5 XLM)
 * and trapping the SAC `transfer` with Error(Contract, #10) "resulting balance
 * not within the allowed range". The invariant below is the contract: after
 * spending the MAX, the wallet must still hold at least its minimum reserve.
 */
describe("maxSpendableXlm", () => {
  it("keeps a 0.5 XLM fee buffer constant", () => {
    expect(XLM_FEE_BUFFER).toBe(0.5);
  });

  it("subtracts reserve + fee buffer from the balance", () => {
    // 100 - 1.5 reserve - 0.5 buffer = 98
    expect(maxSpendableXlm(100, 1.5)).toBeCloseTo(98, 7);
  });

  it("never returns a negative amount when the balance is at/under the floor", () => {
    expect(maxSpendableXlm(2.0, 1.5)).toBe(0); // 2 - 1.5 - 0.5 = 0
    expect(maxSpendableXlm(1.0, 1.5)).toBe(0); // would be negative -> clamped
    expect(maxSpendableXlm(0, 1.5)).toBe(0);
  });

  it("INVARIANT: spending the max always leaves >= the minimum reserve", () => {
    const cases: Array<[number, number]> = [
      [4955.42, 1.5], // the exact reported failure (1 trustline)
      [10_000, 3.0], // heavier multi-trustline account
      [12.34, 2.5],
      [567.42, 1.5],
    ];
    for (const [balance, minReserve] of cases) {
      const spend = maxSpendableXlm(balance, minReserve);
      const remaining = balance - spend;
      // Either nothing is spendable, or the wallet stays above its reserve.
      if (spend > 0) {
        expect(remaining).toBeGreaterThanOrEqual(minReserve);
      } else {
        expect(spend).toBe(0);
      }
    }
  });

  it("reserves strictly more than the old flat-0.5 bug for a multi-subentry account", () => {
    // Old code: balance - 0.5. New code must hold back more so the wallet
    // never lands below a >0.5 minimum reserve.
    const balance = 4955.42;
    const minReserve = 1.5;
    const buggyOld = balance - 0.5;
    expect(maxSpendableXlm(balance, minReserve)).toBeLessThan(buggyOld);
  });
});

describe("getXlmMinReserve (reads the account's real subentry count from chain)", () => {
  // A valid testnet G-address so Keypair.fromPublicKey / xdrAccountId don't throw.
  const ADDR = "GAUVY7FNDKVWRMW3SYEMX6QMFSWQDKC6XIPJJKAMOEMLZPAI7XZPDV3D";

  const mockLedgerEntries = (resolver: () => unknown) =>
    vi
      .spyOn(StellarSdk.rpc.Server.prototype, "getLedgerEntries")
      .mockImplementation(resolver as never);

  afterEach(() => vi.restoreAllMocks());

  it("computes (2 + subentries) × 0.5 from the account entry", async () => {
    mockLedgerEntries(async () => ({
      entries: [{ val: { account: () => ({ numSubEntries: () => 3 }) } }],
    }));
    // base 2 entries + 3 trustlines = 5 × 0.5 = 2.5 XLM
    expect(await getXlmMinReserve(ADDR)).toBe(2.5);
  });

  it("a base account with no subentries floors at 1.0 XLM", async () => {
    mockLedgerEntries(async () => ({
      entries: [{ val: { account: () => ({ numSubEntries: () => 0 }) } }],
    }));
    expect(await getXlmMinReserve(ADDR)).toBe(1.0);
  });

  it("falls back to 1.5 XLM when the ledger entry is missing", async () => {
    mockLedgerEntries(async () => ({ entries: [] }));
    expect(await getXlmMinReserve(ADDR)).toBe(1.5);
  });

  it("falls back to 1.5 XLM on RPC error (never throws)", async () => {
    mockLedgerEntries(async () => {
      throw new Error("rpc unavailable");
    });
    await expect(getXlmMinReserve(ADDR)).resolves.toBe(1.5);
  });
});
