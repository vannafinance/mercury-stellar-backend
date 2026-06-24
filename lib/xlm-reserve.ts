import * as StellarSdk from "@stellar/stellar-sdk";

import { SOROBAN_RPC_URL } from "@/lib/stellar-utils";

// Stellar network base reserve: every account must hold (2 + subentries) of
// these. Subentries = trustlines, offers, data entries, signers. A Vanna user
// typically holds several trustlines (USDC, BLUSDC, AQUSDC, SOUSDC, LP shares),
// each adding 0.5 XLM to the floor — so a flat "keep 0.5 XLM" is wrong.
const BASE_RESERVE_XLM = 0.5;

// Used when the on-chain read fails: base (2 entries = 1 XLM) + one trustline.
const FALLBACK_MIN_RESERVE_XLM = 1.5;

// Headroom kept on top of the strict minimum so transaction fees (and a little
// slack) never push the wallet under its reserve mid-flow.
export const XLM_FEE_BUFFER = 0.5;

/**
 * The minimum native XLM `address` must keep on-chain: `(2 + subentries) ×
 * base_reserve`. A native-XLM transfer that would drop the balance below this
 * traps with "resulting balance is not within the allowed range" (Contract #10)
 * — which is exactly what a MAX deposit hit by reserving only a flat 0.5 XLM.
 * Falls back to a safe constant if the ledger entry can't be read.
 */
export async function getXlmMinReserve(address: string): Promise<number> {
  try {
    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const key = StellarSdk.xdr.LedgerKey.account(
      new StellarSdk.xdr.LedgerKeyAccount({
        accountId: StellarSdk.Keypair.fromPublicKey(address).xdrAccountId(),
      }),
    );
    const resp = await server.getLedgerEntries(key);
    const val = resp.entries?.[0]?.val;
    if (!val) return FALLBACK_MIN_RESERVE_XLM;
    const numSub = Number(val.account().numSubEntries());
    return (2 + numSub) * BASE_RESERVE_XLM;
  } catch {
    return FALLBACK_MIN_RESERVE_XLM;
  }
}

/**
 * Largest amount of XLM that can be moved out of `address` while keeping it
 * above its minimum reserve plus a fee buffer. For non-XLM assets the full
 * balance is spendable (their reserve is the trustline, already accounted for
 * in the XLM floor).
 */
export function maxSpendableXlm(balance: number, minReserve: number): number {
  return Math.max(balance - minReserve - XLM_FEE_BUFFER, 0);
}
