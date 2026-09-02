/**
 * System-wide asset readiness + auto trustline/faucet setup for Copilot writes.
 *
 * Goal: HostError #13 ("trustline entry is missing") must not occur on the
 * write path. Detect missing classic trustlines / unfunded Blend/Aquarius/
 * Soroswap tokens *before* MCP simulation, then either:
 *   1) return an unsigned setup XDR (changeTrust / faucet) for the user to sign,
 *      then resume the original write; or
 *   2) auto-mint when the faucet needs no user signature (Soroswap); or
 *   3) block with a product message when setup is impossible (protocol treasury).
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import {
  ASSET_ISSUERS,
  CONTRACT_ADDRESSES,
  HORIZON_URL,
  NETWORK_PASSPHRASE,
  ContractService,
} from "@/lib/stellar-utils";
import { AquariusService } from "@/lib/aquarius-utils";

const BLEND_FAUCET_URL =
  "https://ewqw4hx7oa.execute-api.us-east-1.amazonaws.com/getAssets";

/** Aquarius testnet distribution key — same as faucet-utils (public in Aquarius app). */
const AQUARIUS_FAUCET_SECRET =
  "SBPQCB4DOUQ26OC43QNAA3ODZOGECHJUVHDHYRHKYPL4SA22RRYGHQCX";
const AQUARIUS_USDC_CODE = "USDC";
const AQUARIUS_USDC_ISSUER = ASSET_ISSUERS.USDC_AQUARIUS;
const AQUARIUS_USDC_FAUCET_AMOUNT = "1000.0000000";

const SOROSWAP_FAUCET_URL = "https://api.soroswap.finance/api/faucet";

export type AssetSetupKind = "blend_faucet" | "aquarius_setup" | "classic_trustline";

export type AssetReadiness =
  | { status: "ready" }
  | {
      status: "needs_setup";
      kind: AssetSetupKind;
      asset: string;
      unsigned_xdr: string;
      label: string;
      message: string;
    }
  | {
      status: "blocked";
      reason:
        | "missing_wallet"
        | "insufficient_balance"
        | "setup_failed"
        | "protocol_trustline"
        | "unsupported";
      message: string;
      facts?: Record<string, unknown>;
    };

/** Ops that pull tokens from the G-wallet and need trustline/balance readiness. */
const WALLET_FUNDED_OPS = new Set([
  "deposit_collateral",
  "lend",
  "supply",
  "deposit_and_borrow",
]);

/** Ops whose swap output may require a classic USDC trustline on the wallet. */
const SWAP_OPS = new Set(["swap", "aquarius_swap"]);

function looksG(a?: string | null): a is string {
  return !!a && /^G[A-Z0-9]{55}$/.test(a);
}

/** Canonical display symbol for readiness messages. */
export function readinessDisplayAsset(raw?: string | null): string {
  const u = String(raw || "").trim().toUpperCase().replace(/[\s_-]/g, "");
  if (!u || u === "XLM") return u || "XLM";
  if (u === "USDC" || u === "BLUSDC" || u === "BLENDUSDC") return "BLUSDC";
  if (u === "AQUSDC" || u === "AQUARIUSUSDC") return "AQUSDC";
  if (u === "SOUSDC" || u === "SOROSWAPUSDC") return "SOUSDC";
  return String(raw || "").trim().toUpperCase() || "TOKEN";
}

function sacContractFor(display: string): string | null {
  if (display === "BLUSDC") return CONTRACT_ADDRESSES.BLEND_USDC;
  if (display === "AQUSDC") return CONTRACT_ADDRESSES.AQUARIUS_USDC;
  if (display === "SOUSDC") return CONTRACT_ADDRESSES.SOROSWAP_USDC;
  return null;
}

async function walletSacBalance(trader: string, display: string): Promise<number> {
  if (display === "XLM") {
    try {
      const server = new StellarSdk.Horizon.Server(HORIZON_URL);
      const account = await server.loadAccount(trader);
      const native = account.balances.find((b) => b.asset_type === "native");
      return native ? parseFloat(native.balance) || 0 : 0;
    } catch (e) {
      /**
       * A failed balance check is not the same fact as a zero balance, and reporting it
       * as one is a false claim, not a safe default — the preflight this feeds built
       * "You asked for 10 XLM but the wallet only has ~0.0000 XLM" for an account the
       * Margin page showed holding 9,806 XLM at the same moment. This Horizon call is a
       * SEPARATE read path from the one `vanna_get_wallet_balance` uses (that one kept
       * reporting real numbers all session), so the two disagreeing means THIS path was
       * the one failing, not that the wallet emptied.
       *
       * A 404 is different: Horizon's own way of saying the account has never been
       * funded, which genuinely is zero. Anything else — timeout, DNS, 5xx — is "we don't
       * know," and "unknown" must never render as a specific, confident, wrong number.
       * The non-XLM branch below already treats "unknown" as "don't block" — an
       * unrecognised contract returns `Number.POSITIVE_INFINITY`, not 0. XLM was the one
       * branch that didn't follow that rule, which is why this bug only ever showed up
       * for XLM deposits.
       */
      const notFound =
        e instanceof Error && (/not\s*found/i.test(e.message) || /404/.test(e.message));
      if (notFound) return 0;
      console.warn(
        `[copilot] Horizon balance check failed for ${trader} — treating as unknown, not zero:`,
        e instanceof Error ? e.message : e,
      );
      return Number.POSITIVE_INFINITY;
    }
  }
  const contract = sacContractFor(display);
  if (!contract) return Number.POSITIVE_INFINITY; // unknown — don't block
  const bal = await ContractService.getSorobanTokenWalletBalance(contract, trader);
  return parseFloat(bal) || 0;
}

/** Fetch Blend faucet envelope (partially signed). Empty ops ⇒ already set up. */
export async function fetchBlendFaucetXdr(
  gAddress: string,
): Promise<{ xdr: string } | { alreadyReady: true } | { error: string }> {
  try {
    const url = `${BLEND_FAUCET_URL}?userId=${encodeURIComponent(gAddress)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { error: `Blend faucet ${res.status}: ${errText.slice(0, 120)}` };
    }
    const xdrBase64 = (await res.text()).replace(/^"|"$/g, "");
    if (!xdrBase64) return { error: "Blend faucet returned empty body" };
    const tx = StellarSdk.TransactionBuilder.fromXDR(xdrBase64, NETWORK_PASSPHRASE);
    if (tx.operations.length === 0) return { alreadyReady: true };
    return { xdr: xdrBase64 };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Blend faucet request failed" };
  }
}

/**
 * Build Aquarius USDC changeTrust (+ optional faucet payment), faucet-signed.
 * User still signs as tx source. Returns null XDR path via alreadyReady when
 * trustline exists and `mintIfMissing` is false.
 */
export async function buildAquariusUsdcSetupXdr(
  gAddress: string,
  opts: { mintIfMissing?: boolean } = {},
): Promise<{ xdr: string } | { alreadyReady: true } | { error: string }> {
  const mintIfMissing = opts.mintIfMissing !== false;
  try {
    const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
    const userAccount = await horizon.loadAccount(gAddress);
    const faucetKeypair = StellarSdk.Keypair.fromSecret(AQUARIUS_FAUCET_SECRET);
    const asset = new StellarSdk.Asset(AQUARIUS_USDC_CODE, AQUARIUS_USDC_ISSUER);

    const hasTrust = userAccount.balances.some((b) => {
      if (b.asset_type !== "credit_alphanum4" && b.asset_type !== "credit_alphanum12") {
        return false;
      }
      const line = b as StellarSdk.Horizon.HorizonApi.BalanceLineAsset;
      return line.asset_code === AQUARIUS_USDC_CODE && line.asset_issuer === AQUARIUS_USDC_ISSUER;
    });

    if (hasTrust && !mintIfMissing) return { alreadyReady: true };

    const txBuilder = new StellarSdk.TransactionBuilder(userAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    }).setTimeout(180);

    if (!hasTrust) {
      txBuilder.addOperation(StellarSdk.Operation.changeTrust({ asset }));
    }
    if (mintIfMissing) {
      txBuilder.addOperation(
        StellarSdk.Operation.payment({
          source: faucetKeypair.publicKey(),
          destination: gAddress,
          asset,
          amount: AQUARIUS_USDC_FAUCET_AMOUNT,
        }),
      );
    }

    const built = txBuilder.build();
    if (built.operations.length === 0) return { alreadyReady: true };
    built.sign(faucetKeypair);
    return { xdr: built.toXDR() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Aquarius setup failed" };
  }
}

/** Classic changeTrust only (no mint) for Aquarius USDC. */
export async function buildAquariusChangeTrustXdr(
  gAddress: string,
): Promise<{ xdr: string } | { alreadyReady: true } | { error: string }> {
  return buildAquariusUsdcSetupXdr(gAddress, { mintIfMissing: false });
}

/** Soroswap faucet mints without a user signature — safe to call server-side. */
export async function autoMintSoroswapUsdc(
  gAddress: string,
): Promise<{ ok: true; hash?: string } | { ok: false; error: string }> {
  try {
    const url =
      `${SOROSWAP_FAUCET_URL}?address=${encodeURIComponent(gAddress)}` +
      `&contract=${encodeURIComponent(CONTRACT_ADDRESSES.SOROSWAP_USDC)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const body = (await res.json().catch(() => null)) as {
      status?: string;
      txHash?: string;
      message?: string;
    } | null;
    if (res.ok && body?.status === "SUCCESS") {
      return { ok: true, hash: body.txHash };
    }
    return { ok: false, error: body?.message || `Soroswap faucet ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Soroswap faucet failed" };
  }
}

/**
 * Detect trustline / HostError #13 style failures for fallback humanization.
 * Prefer calling this only after preflight — prevention is the primary path.
 */
export function isTrustlineMissingError(raw: string): boolean {
  const t = raw.toLowerCase();
  return (
    t.includes("trustline entry is missing") ||
    t.includes("error(contract, #13)") ||
    /\bhosterror\b.*#\s*13\b/i.test(raw) ||
    /#\s*13\b.*trustline/i.test(t)
  );
}

/**
 * Structured fallback when a trustline error still slips past preflight.
 * Distinguishes wallet setup vs protocol treasury when the account is visible.
 */
export function classifyTrustlineFailure(raw: string, opts?: {
  asset?: string | null;
  trader?: string | null;
  tool?: string | null;
}): { reason: "wallet_setup" | "protocol_treasury" | "destination_trustline"; message: string } {
  const asset = readinessDisplayAsset(opts?.asset);
  const match = raw.match(/trustline entry is missing for account["\s,]*([A-Z0-9]{56})/i);
  const missingAccount = match?.[1] || null;
  const trader = opts?.trader || null;

  if (missingAccount && trader && missingAccount === trader) {
    return {
      reason: "wallet_setup",
      message:
        `${asset} is not set up in your wallet yet (missing trustline). ` +
        `Copilot will open the trustline / faucet funding first on retry — no raw contract error.`,
    };
  }

  if (
    missingAccount &&
    trader &&
    missingAccount !== trader &&
    /^G[A-Z0-9]{55}$/.test(missingAccount)
  ) {
    return {
      reason: "protocol_treasury",
      message:
        `This ${asset} operation needs a lending-pool treasury trustline that is not configured ` +
        `(account ${missingAccount.slice(0, 4)}…${missingAccount.slice(-4)}). ` +
        `That is a protocol setup issue, not your wallet. Try a different asset (e.g. AQUSDC or XLM) ` +
        `or ask an admin to configure the pool treasury.`,
    };
  }

  if (/swap|liquidity/i.test(String(opts?.tool || ""))) {
    return {
      reason: "destination_trustline",
      message:
        `Destination token trustline is missing in your wallet for this ${asset} swap/LP. ` +
        `Open the trustline (Faucet / changeTrust) then retry — Copilot will try to set it up automatically next time.`,
    };
  }

  return {
    reason: "wallet_setup",
    message:
      `${asset} is not ready in your wallet (trustline / faucet funding missing). ` +
      `Use Faucet to mint ${asset === "BLUSDC" ? "Blend USDC" : asset === "AQUSDC" ? "Aquarius USDC" : asset}, ` +
      `then retry. No transaction was submitted.`,
  };
}

async function ensureWalletAssetReady(
  trader: string,
  display: string,
  amount: number,
): Promise<AssetReadiness> {
  if (display === "XLM") {
    const bal = await walletSacBalance(trader, "XLM");
    if (amount > 0 && bal + 1e-7 < amount) {
      return {
        status: "blocked",
        reason: "insufficient_balance",
        message:
          `You asked for ${amount} XLM but the wallet only has ~${bal.toFixed(4)} XLM. ` +
          `Reduce the amount (leave ~1 XLM for fees) — no transaction was built.`,
        facts: { available: bal, requested: amount, asset: "XLM" },
      };
    }
    return { status: "ready" };
  }

  if (display === "SOUSDC") {
    let bal = await walletSacBalance(trader, "SOUSDC");
    if (amount > 0 && bal + 1e-7 < amount) {
      const minted = await autoMintSoroswapUsdc(trader);
      if (minted.ok) {
        bal = await walletSacBalance(trader, "SOUSDC");
      }
      if (bal + 1e-7 < amount) {
        return {
          status: "blocked",
          reason: minted.ok ? "insufficient_balance" : "setup_failed",
          message: minted.ok
            ? `After Soroswap faucet mint, wallet has ~${bal.toFixed(4)} SOUSDC but you need ${amount}. Try a smaller amount.`
            : `Could not auto-fund SOUSDC (${"error" in minted ? minted.error : "faucet failed"}). Open Faucet → Soroswap USDC, then retry.`,
          facts: { available: bal, requested: amount, asset: "SOUSDC" },
        };
      }
    }
    return { status: "ready" };
  }

  if (display === "AQUSDC") {
    const hasClassic = await AquariusService.hasAquariusUsdcTrustline(trader);
    const bal = await walletSacBalance(trader, "AQUSDC");
    const needFunds = amount > 0 && bal + 1e-7 < amount;

    if (!hasClassic || needFunds) {
      const setup = await buildAquariusUsdcSetupXdr(trader, { mintIfMissing: needFunds || !hasClassic });
      if ("error" in setup) {
        return {
          status: "blocked",
          reason: "setup_failed",
          message: `Could not prepare AQUSDC trustline/faucet setup: ${setup.error}`,
        };
      }
      if ("xdr" in setup) {
        return {
          status: "needs_setup",
          kind: needFunds ? "aquarius_setup" : "classic_trustline",
          asset: "AQUSDC",
          unsigned_xdr: setup.xdr,
          label: needFunds
            ? "Setup AQUSDC trustline + faucet mint"
            : "Open AQUSDC (Aquarius USDC) trustline",
          message:
            `AQUSDC is not ready in your wallet yet` +
            (!hasClassic ? " (classic trustline missing)" : "") +
            (needFunds ? ` — need ${amount}, have ~${bal.toFixed(4)}` : "") +
            `. Sign this setup transaction first; Copilot continues your original action automatically after it confirms.`,
        };
      }
      // alreadyReady but still short on SAC balance (shouldn't mint-skip)
      if (needFunds) {
        return {
          status: "blocked",
          reason: "insufficient_balance",
          message:
            `Wallet has ~${bal.toFixed(4)} AQUSDC but you need ${amount}. ` +
            `Mint more via Faucet or reduce the amount.`,
          facts: { available: bal, requested: amount, asset: "AQUSDC" },
        };
      }
    }
    return { status: "ready" };
  }

  if (display === "BLUSDC") {
    // Blend faucet establishes classic USDC trustlines + mints Blend basket.
    // Probe it before any deposit/lend so HostError #13 never hits MCP sim.
    const faucet = await fetchBlendFaucetXdr(trader);
    if ("error" in faucet) {
      // Soft: if we can still see enough SAC balance, proceed; else block.
      const bal = await walletSacBalance(trader, "BLUSDC");
      if (amount > 0 && bal + 1e-7 < amount) {
        return {
          status: "blocked",
          reason: "setup_failed",
          message:
            `Could not reach Blend faucet to set up BLUSDC (${faucet.error}). ` +
            `Open Faucet → Blend USDC (establishes trustline), then retry.`,
        };
      }
      return { status: "ready" };
    }
    if ("xdr" in faucet) {
      return {
        status: "needs_setup",
        kind: "blend_faucet",
        asset: "BLUSDC",
        unsigned_xdr: faucet.xdr,
        label: "Setup BLUSDC trustline / Blend faucet",
        message:
          `BLUSDC is not set up in your wallet yet (trustline / Blend faucet funding). ` +
          `Sign this setup transaction first — it opens the required trustlines and funds Blend USDC. ` +
          `Copilot continues your original action automatically after it confirms.`,
      };
    }
    // alreadyReady — trustlines exist; still need enough SAC balance
    const bal = await walletSacBalance(trader, "BLUSDC");
    if (amount > 0 && bal + 1e-7 < amount) {
      return {
        status: "blocked",
        reason: "insufficient_balance",
        message:
          `Blend trustlines are open, but the wallet only has ~${bal.toFixed(4)} BLUSDC ` +
          `and you asked for ${amount}. Reduce the amount or fund BLUSDC another way — ` +
          `no deposit was simulated.`,
        facts: { available: bal, requested: amount, asset: "BLUSDC" },
      };
    }
    return { status: "ready" };
  }

  return { status: "ready" };
}

/**
 * Preflight one write. Call before executeMcpWrite / multi-leg legs that spend
 * wallet assets or produce classic swap destinations.
 */
export async function preflightAssetReadiness(params: {
  op: string;
  asset?: string | null;
  amount?: number | null;
  token_out?: string | null;
  trader?: string | null;
}): Promise<AssetReadiness> {
  const op = String(params.op || "");
  const trader = params.trader ?? null;

  if (WALLET_FUNDED_OPS.has(op)) {
    if (!looksG(trader)) {
      return {
        status: "blocked",
        reason: "missing_wallet",
        message: "Connect your wallet before depositing or lending.",
      };
    }
    const display = readinessDisplayAsset(params.asset);
    const amount =
      params.amount != null && Number.isFinite(params.amount) ? Number(params.amount) : 0;
    return ensureWalletAssetReady(trader, display, amount);
  }

  if (SWAP_OPS.has(op) && looksG(trader)) {
    const out = readinessDisplayAsset(params.token_out || params.asset);
    // Aquarius classic USDC out requires trustline
    if (out === "AQUSDC" || out === "USDC" || out === "BLUSDC") {
      // Prefer Aquarius classic check when swapping to USDC family on Aquarius
      if (out === "AQUSDC" || (op.includes("aquarius") && (out === "USDC" || out === "BLUSDC"))) {
        const has = await AquariusService.hasAquariusUsdcTrustline(trader);
        if (!has) {
          const setup = await buildAquariusChangeTrustXdr(trader);
          if ("xdr" in setup) {
            return {
              status: "needs_setup",
              kind: "classic_trustline",
              asset: "AQUSDC",
              unsigned_xdr: setup.xdr,
              label: "Open Aquarius USDC trustline",
              message:
                `Your wallet needs an Aquarius USDC trustline before this swap can settle. ` +
                `Sign this setup first; Copilot retries the swap after it confirms.`,
            };
          }
          if ("error" in setup) {
            return {
              status: "blocked",
              reason: "setup_failed",
              message: `Could not prepare USDC trustline setup: ${setup.error}`,
            };
          }
        }
      }
    }
  }

  return { status: "ready" };
}
