import { Account, Keypair, Networks, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { assertNativeFeeBudget, checkTransactionFee } from "@/lib/copilot/workflow/fee-budget";
import type { ProposalStep } from "@/lib/copilot/workflow/types";

const wallet = Keypair.random().publicKey();
const envelope = (fee: string) => new TransactionBuilder(new Account(wallet, "1"), { fee, networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.invokeContractFunction({ contract: StrKey.encodeContract(Buffer.alloc(32, 2)), function: "supply", args: [] }))
  .setTimeout(300).build();
const supply: ProposalStep = { id: "supply", op: "supply_blend", asset: "XLM", amount: "9999.965427", label: "Supply", tool: "vanna_blend_supply", args: {} };
const account = (balance = "3.9634782", liabilities = "0") => ({ account_id: wallet, subentry_count: 5, num_sponsoring: 0, num_sponsored: 0,
  balances: [{ asset_type: "native", balance, selling_liabilities: liabilities }] });
const ledger = { base_reserve_in_stroops: 5_000_000 };

describe("prepared transaction fee affordability", () => {
  it("refuses the observed Blend fee before signing or broadcasting", () => {
    const tx = envelope("7648031"); const before = tx.toXDR();
    expect(() => assertNativeFeeBudget(tx, supply, account(), ledger)).toThrow("0.7648031 XLM in fees");
    expect(() => assertNativeFeeBudget(tx, supply, account(), ledger)).toThrow("0.3013249 XLM");
    expect(tx.toXDR()).toBe(before); expect(tx.signatures).toHaveLength(0);
  });
  it("accepts a sufficient balance without reserving the margin supply as a wallet debit", () => {
    expect(() => assertNativeFeeBudget(envelope("7648031"), supply, account("4.2648031"), ledger)).not.toThrow();
  });
  it("counts the native wallet debit and selling liabilities alongside the full fee", () => {
    const step = { ...supply, op: "deposit_collateral" as const, amount: "5" };
    expect(() => assertNativeFeeBudget(envelope("100"), step, account("8.50001", "0.1"), ledger)).toThrow("Nothing was submitted");
    expect(() => assertNativeFeeBudget(envelope("100"), step, account("8.60001", "0.1"), ledger)).not.toThrow();
  });
  it("derives sponsored reserves from the current header instead of assuming 0.5 XLM", () => {
    const sponsored = { ...account("2.00001"), num_sponsoring: 1, num_sponsored: 3 };
    expect(() => assertNativeFeeBudget(envelope("100"), supply, sponsored, { base_reserve_in_stroops: 4_000_000 })).not.toThrow();
  });
  it.each([
    { ...account(), account_id: Keypair.random().publicKey() },
    { ...account(), subentry_count: undefined },
    { ...account(), balances: [{ asset_type: "native", balance: "3.9" }] },
    { ...account(), balances: [{ asset_type: "native", balance: "invalid", selling_liabilities: "0" }] },
  ])("fails closed on missing or inconsistent account data", malformed => {
    expect(() => assertNativeFeeBudget(envelope("100"), supply, malformed, ledger)).toThrow("could not be verified");
  });
  it("reads only the native account and latest ledger, without submitting a transaction", async () => {
    const request = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("/accounts/")
      ? account("5") : { _embedded: { records: [ledger] } })));
    await checkTransactionFee(envelope("7648031").toXDR(), supply, request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(call => !String(call[0]).includes("transactions"))).toBe(true);
  });
  it("does not turn an unreadable ledger into an assumed reserve", async () => {
    const request = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("/accounts/")
      ? account("5") : { _embedded: { records: [] } })));
    await expect(checkTransactionFee(envelope("100").toXDR(), supply, request)).rejects.toThrow("could not be verified");
  });
});
