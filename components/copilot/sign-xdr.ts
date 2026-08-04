/**
 * Client-side sign + submit for an XDR the MCP server already built.
 *
 * Why this exists: the copilot's write path asks the MCP server to build the
 * transaction (`vanna_deposit_collateral`, `vanna_borrow`, …). MCP simulates it,
 * assembles the Soroban resource footprint, and returns an `unsigned_xdr`. When
 * Sign Service auto-sign is unavailable (no user assertion bound to the server's
 * M2M token) the only thing missing is the user's signature — NOT a second copy
 * of the transaction.
 *
 * Previously "Sign with connected wallet" threw that XDR away and rebuilt the
 * whole call through `MarginAccountService`, which re-ran its own Registry /
 * collateral pre-flight and needed its own `getAddress()`. That double build is
 * where "Failed to get user address" and the bogus "XLM not set in the Registry
 * contract" toasts came from — MCP had already simulated the same call
 * successfully. So: sign what MCP built, submit it, poll it. Nothing else.
 *
 * This module runs in the browser only (it needs the wallet).
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, SOROBAN_RPC_URL } from "@/lib/stellar-utils";
import { getAddress, signTransaction } from "@/lib/wallet-adapter";

export type SignXdrResult =
  | { ok: true; hash: string }
  | { ok: false; error: string; hash?: string };

/**
 * Whether a string is an envelope we can actually sign.
 *
 * Matters because `MCP_MODE=mock` returns the sentinel `"AAAA...MOCK_XDR::<tool>"`,
 * which is long enough to look real. Callers use this to decide between the
 * sign-the-MCP-envelope path and the local rebuild fallback, so a mock/garbled
 * value degrades to the old behaviour instead of erroring at the sign step.
 */
export function isSignableXdr(xdr: string | null | undefined): xdr is string {
  if (!xdr || xdr.length < 20) return false;
  try {
    const parsed = StellarSdk.TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
    return "source" in parsed;
  } catch {
    return false;
  }
}

/**
 * Poll until the ledger has an answer.
 *
 * `getTransaction` only ever returns SUCCESS | FAILED | NOT_FOUND, and NOT_FOUND
 * is the "still in the mempool" case. On FAILED we pull the transaction result
 * code out so the caller can say *why* instead of just "failed".
 */
async function pollTransaction(
  server: StellarSdk.rpc.Server,
  hash: string,
  // 60 × 1s ≈ 60s, was 20 × 1.5s = 30s. Testnet regularly needs 30–60s, so the
  // old window gave up on transactions that were about to land and reported them
  // as failures with a hash — the worst of both readings. Polling a little
  // faster also shortens the gap between confirmation and the UI showing it.
  // This strengthens confirmation: nothing is accepted earlier, we just stop
  // abandoning it sooner than the network answers.
  { attempts = 60, delayMs = 1000 } = {},
): Promise<{ status: string; reason?: string }> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await server.getTransaction(hash);
      if (res.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
        return { status: "SUCCESS" };
      }
      if (res.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
        let reason: string | undefined;
        try {
          reason = res.resultXdr?.result().switch().name;
        } catch {
          /* result code unavailable — fall back to a bare failure */
        }
        return { status: "FAILED", reason };
      }
      // NOT_FOUND → not in a ledger yet.
    } catch {
      /* transient RPC hiccup — testnet does this; keep polling */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { status: "TIMEOUT" };
}

/**
 * Sign an MCP-built transaction envelope with the connected wallet and submit it.
 *
 * @param unsignedXdr - envelope XDR returned by an MCP write tool (already
 *                      simulated + resource-assembled server-side).
 * @param expectedSigner - the G-address the copilot believes is connected. Used
 *                         only to catch an envelope built for a different source
 *                         account before we ask the user to sign it.
 */
export async function signAndSubmitMcpXdr(
  unsignedXdr: string,
  expectedSigner?: string | null,
  /**
   * Fired the moment the network accepts the envelope, BEFORE polling starts.
   *
   * Confirmation can take the better part of a minute, and until this existed
   * the caller had nothing to show for that time — the leg sat on a spinner with
   * no hash, which reads as hung rather than pending. The hash exists as soon as
   * the submit returns, so hand it over then; the user can check the explorer
   * even if they close the tab.
   */
  onSubmitted?: (hash: string) => void,
): Promise<SignXdrResult> {
  if (!unsignedXdr || unsignedXdr.length < 20) {
    return { ok: false, error: "No transaction to sign — re-run the request." };
  }

  // 1. Resolve the signing address. `interactive` is safe here specifically
  //    because the user just pressed approve, so a Freighter unlock prompt is
  //    expected rather than a surprise. The adapter will resync Privy and fall
  //    back to Freighter if the Vanna (Privy) bridge is still hydrating.
  const acct = await getAddress({ interactive: true });
  if (acct.error || !acct.address) {
    const detail = typeof acct.error === "string" ? acct.error : acct.error?.message;
    return {
      ok: false,
      error:
        detail ||
        "Wallet unavailable — unlock Freighter / reconnect in the navbar, wait a second, then press sign again.",
    };
  }

  // 2. Parse the envelope and sanity-check the source account.
  let tx: StellarSdk.Transaction;
  try {
    const parsed = StellarSdk.TransactionBuilder.fromXDR(unsignedXdr, NETWORK_PASSPHRASE);
    if (!("source" in parsed)) {
      return { ok: false, error: "MCP returned a fee-bump envelope, which the copilot can't sign yet." };
    }
    tx = parsed as StellarSdk.Transaction;
  } catch (e) {
    return {
      ok: false,
      error: `Could not read the transaction MCP built (${e instanceof Error ? e.message : "invalid XDR"}).`,
    };
  }

  // The envelope must be signed by its source account — Soroban requires that
  // regardless of any auth entries — so compare against the address that will
  // ACTUALLY sign (`acct.address`), not the one the copilot remembered. Those
  // differ when the user switches accounts inside Freighter mid-session, which
  // would otherwise sail past the guard and fail on-chain with `txBadAuth`.
  if (tx.source !== acct.address) {
    const built = `${tx.source.slice(0, 6)}…${tx.source.slice(-4)}`;
    const active = `${acct.address.slice(0, 6)}…${acct.address.slice(-4)}`;
    return {
      ok: false,
      error:
        expectedSigner && expectedSigner !== acct.address
          ? `Your wallet is now on ${active}, but this transaction was built for ${built}. ` +
            "Switch back or re-run the request."
          : `This transaction is built for ${built} and ${active} is connected. ` +
            "Switch wallets or re-run the request.",
    };
  }

  // 3. Sign via whichever wallet is active (Freighter extension or Privy raw-hash).
  const signed = await signTransaction(tx.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: acct.address,
  });
  if (signed.error || !signed.signedTxXdr) {
    const detail = typeof signed.error === "string" ? signed.error : signed.error?.message;
    return { ok: false, error: detail || "Signing was cancelled." };
  }

  // 4. Submit + poll. MCP already simulated, so we do NOT re-prepare (that would
  //    invalidate the signature by mutating the envelope).
  try {
    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const envelope = StellarSdk.TransactionBuilder.fromXDR(
      signed.signedTxXdr,
      NETWORK_PASSPHRASE,
    ) as StellarSdk.Transaction;

    const sent = await server.sendTransaction(envelope);

    if (sent.status === "ERROR") {
      const reason = sent.errorResult?.result().switch().name ?? "rejected by RPC";
      return { ok: false, error: `Submission rejected: ${reason}` };
    }
    // TRY_AGAIN_LATER means it was NOT queued — polling would just time out and
    // hand the user a hash that never lands. Say what actually happened.
    if (sent.status === "TRY_AGAIN_LATER") {
      return {
        ok: false,
        error:
          "The network asked us to retry — usually another transaction from this " +
          "account is still in flight. Press approve again in a few seconds.",
      };
    }
    // PENDING and DUPLICATE both mean "it's in", so poll for the outcome.
    // Tell the caller now — the wait that follows is the long part.
    try {
      onSubmitted?.(sent.hash);
    } catch {
      /* a UI callback must never take down the submit path */
    }

    const final = await pollTransaction(server, sent.hash);
    if (final.status === "SUCCESS") return { ok: true, hash: sent.hash };
    if (final.status === "TIMEOUT") {
      return {
        ok: false,
        hash: sent.hash,
        error:
          `Submitted, but the ledger had not confirmed it after 60s. It may still land — ` +
          `check ${sent.hash.slice(0, 10)}… on the explorer before retrying, so you do not ` +
          `send the same transaction twice.`,
      };
    }
    return {
      ok: false,
      hash: sent.hash,
      error: `Transaction failed on-chain${final.reason ? ` (${final.reason})` : ""}.`,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to submit the signed transaction.",
    };
  }
}
