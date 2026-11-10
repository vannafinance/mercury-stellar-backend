import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction } from '@/lib/wallet-adapter';
import { CONTRACT_ADDRESSES, NETWORK_PASSPHRASE, SOROBAN_RPC_URL, HORIZON_URL } from './stellar-utils';

// ─── Faucet endpoints / constants ──────────────────────────────────────────
const FRIENDBOT_URL = 'https://friendbot.stellar.org';
// Routed through our own /api/faucet/blend (see that route's doc comment) —
// Blend's endpoint has no CORS allowlist for our domain, so calling it
// directly from the browser gets blocked ("blocked by CORS policy") even
// though the request itself succeeds server-side.
const BLEND_FAUCET_URL = '/api/faucet/blend';
const SOROSWAP_FAUCET_URL = 'https://api.soroswap.finance/api/faucet';

export type FaucetTokenId =
  | 'XLM' | 'BLEND_USDC' | 'SOROSWAP_USDC';

export interface FaucetResult {
  ok: boolean;
  hash?: string;
  alreadyFunded?: boolean;
  error?: string;
}

// ─── XLM via Friendbot ──────────────────────────────────────────────────────
export const fundXlmViaFriendbot = async (address: string): Promise<FaucetResult> => {
  try {
    const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`;
    const res = await fetch(url, { method: 'GET' });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: true, hash: body?.hash };
    }
    // Friendbot returns 400 once an account is funded. The body is a JSON
    // problem document; surface a friendly message for the common cases
    // instead of dumping raw "Friendbot 400: { type: ... }" at the user.
    const errText = await res.text().catch(() => '');
    if (
      errText.includes('op_already_exists') ||
      errText.includes('createAccountAlreadyExist') ||
      errText.includes('account already funded')
    ) {
      return { ok: true, alreadyFunded: true };
    }
    let detail = '';
    try {
      const parsed = JSON.parse(errText);
      detail = parsed?.detail || parsed?.title || '';
    } catch {
      detail = errText.slice(0, 160);
    }
    return { ok: false, error: detail || `Friendbot returned ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Friendbot request failed' };
  }
};

// ─── Soroswap faucet API (any SAC it recognizes, keyed by contract address) ─
// The API mints whichever token contract you pass.
const fundSoroswapToken = async (address: string, contract: string): Promise<FaucetResult> => {
  try {
    const url = `${SOROSWAP_FAUCET_URL}?address=${encodeURIComponent(address)}&contract=${encodeURIComponent(contract)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.json().catch(() => null) as { status?: string; txHash?: string; message?: string } | null;
    if (res.ok && body?.status === 'SUCCESS') {
      return { ok: true, hash: body.txHash };
    }
    return { ok: false, error: body?.message || `Soroswap faucet ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Soroswap faucet request failed' };
  }
};

export const fundSoroswapUsdc = (address: string) =>
  fundSoroswapToken(address, CONTRACT_ADDRESSES.SOROSWAP_USDC);

// ─── Blend USDC via Blend's getAssets endpoint ─────────────────────────────
// Blend returns a TransactionEnvelope already signed by their distribution
// account. We add the user's signature (Freighter) and submit. This mints
// the Blend testnet basket: USDC, BLND, wETH, wBTC + trustlines as needed.
export const fundBlendAssets = async (address: string): Promise<FaucetResult> => {
  try {
    const url = `${BLEND_FAUCET_URL}?userId=${encodeURIComponent(address)}`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: `Blend faucet ${res.status}: ${errText.slice(0, 160)}` };
    }
    const xdrBase64 = (await res.text()).replace(/^"|"$/g, '');
    if (!xdrBase64) return { ok: false, error: 'Blend faucet returned empty body' };

    const partiallySignedTx = StellarSdk.TransactionBuilder.fromXDR(
      xdrBase64,
      NETWORK_PASSPHRASE
    );
    // If Blend's faucet returns a tx with no payment operations, the user
    // already has all required Blend trustlines + balances funded — the
    // backend has nothing left to send. Surface this as "already funded"
    // instead of crashing later with "tx_missing_operation".
    if (partiallySignedTx.operations.length === 0) {
      return { ok: true, alreadyFunded: true };
    }

    const signedXdr = await signTransaction(partiallySignedTx.toXDR(), {
      networkPassphrase: NETWORK_PASSPHRASE,
      address,
    });
    if (signedXdr.error) return { ok: false, error: String(signedXdr.error) };

    const finalTx = StellarSdk.TransactionBuilder.fromXDR(
      signedXdr.signedTxXdr,
      NETWORK_PASSPHRASE
    );

    // Blend's tx is mostly classic-asset ops (changeTrust + payment) so
    // Horizon's transactions endpoint is the right submitter. Use Soroban
    // RPC only when the body actually invokes a host function.
    const isSoroban = finalTx.operations.some((op) => op.type === 'invokeHostFunction');
    if (isSoroban) {
      const sorobanServer = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sent = await sorobanServer.sendTransaction(finalTx as StellarSdk.Transaction);
      if (sent.status === 'PENDING' || sent.status === 'DUPLICATE') {
        return { ok: true, hash: sent.hash };
      }
      return { ok: false, error: `Submit failed: ${sent.status}` };
    } else {
      const horizonServer = new StellarSdk.Horizon.Server(HORIZON_URL);
      const result = await horizonServer.submitTransaction(finalTx as StellarSdk.Transaction);
      return { ok: true, hash: result.hash };
    }
  } catch (e: unknown) {
    const err = e as { response?: { data?: { extras?: { result_codes?: unknown } } }; message?: string };
    const horizonExtras = err?.response?.data?.extras?.result_codes;
    // tx_missing_operation == Blend already topped this account up; nothing
    // left to mint. Treat as success-already-funded so the UI doesn't show
    // a scary red error.
    const horizonStr = horizonExtras ? JSON.stringify(horizonExtras) : '';
    if (
      horizonStr.includes('tx_missing_operation') ||
      err?.message?.includes('tx_missing_operation') ||
      horizonStr.includes('op_already_exists')
    ) {
      return { ok: true, alreadyFunded: true };
    }
    const msg = horizonExtras
      ? JSON.stringify(horizonExtras).slice(0, 200)
      : err?.message || 'Blend faucet submission failed';
    return { ok: false, error: msg };
  }
};

// No Aquarius USDC faucet since mainnet-credit-layer: Aquarius trades Blend
// USDC (BLUSDC), so the Blend faucet funds it. The old Aquarius test USDC's
// issuer account no longer exists, so it can't take new holders.

// Mint behaviour per token. The UI uses this to decide whether to keep the
// button disabled forever after the first success ('one-time'), enforce a
// cooldown timer between mints ('cooldown'), or always allow re-minting
// ('unlimited').
export type FaucetTokenCategory = 'one-time' | 'cooldown' | 'unlimited';

export interface FaucetTokenMeta {
  label: string;
  icon: string;
  description: string;
  category: FaucetTokenCategory;
  cooldownMs?: number; // only used when category === 'cooldown'
}

export const FAUCET_TOKEN_META: Record<FaucetTokenId, FaucetTokenMeta> = {
  XLM: {
    label: 'XLM',
    icon: '/coins/xlmbg.png',
    description: 'Native Stellar asset · 10,000 XLM via Friendbot (one-time)',
    // Friendbot creates the account once with 10,000 XLM. Subsequent calls
    // return "account already funded" — no point retrying.
    category: 'one-time',
  },
  BLEND_USDC: {
    label: 'Blend USDC',
    icon: '/icons/usdc-icon.svg',
    description: 'Blend testnet basket · USDC (also traded on Aquarius) + BLND + wETH + wBTC (one-time)',
    // Blend's faucet sends the basket (changeTrust + payments) once. After
    // that the trustlines exist, balances are paid; nothing to re-mint.
    category: 'one-time',
  },
  SOROSWAP_USDC: {
    label: 'Soroswap USDC',
    icon: '/icons/soroswap-logo.png',
    description: 'Soroswap testnet faucet · 5 mints/min cooldown',
    category: 'cooldown',
    cooldownMs: 12_000, // 5/min ≈ one mint every 12 seconds
  },
};

export const runFaucet = async (
  token: FaucetTokenId,
  address: string
): Promise<FaucetResult> => {
  switch (token) {
    case 'XLM':
      return fundXlmViaFriendbot(address);
    case 'BLEND_USDC':
      return fundBlendAssets(address);
    case 'SOROSWAP_USDC':
      return fundSoroswapUsdc(address);
  }
};
