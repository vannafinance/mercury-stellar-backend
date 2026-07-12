import * as FreighterApi from '@stellar/freighter-api';
import * as StellarSdk from '@stellar/stellar-sdk';

/**
 * Wallet-kind-agnostic drop-in replacement for `@stellar/freighter-api`'s
 * `getAddress`/`requestAccess`/`signTransaction`. Every existing call site in
 * lib/*.ts and a few components imports these three functions directly from
 * Freighter; swapping the import to this module (same names, same call
 * shapes — including the exact return types) makes them work under whichever
 * wallet is currently active, without touching the call sites themselves.
 *
 * Freighter stays a live browser-extension call, so it's simply passed
 * through. Privy only exposes raw-hash signing for Stellar (no XDR
 * awareness), so this module owns turning a prepared transaction's XDR into
 * a hash, getting it signed via the registered Privy bridge, and
 * reassembling a signed XDR the rest of the app already expects.
 */

export type WalletKind = 'freighter' | 'privy';

type WalletApiError = { code?: number; message?: string; ext?: string[] } | string;

interface PrivyBridge {
  address: string;
  signRawHash: (args: {
    address: string;
    chainType: 'stellar';
    hash: `0x${string}`;
  }) => Promise<{ signature: `0x${string}` }>;
}

interface PrivyAuthControls {
  login: () => void;
  logout: () => Promise<void>;
}

let activeWalletKind: WalletKind | null = null;
let privyBridge: PrivyBridge | null = null;
let privyAuthControls: PrivyAuthControls | null = null;

export function setActiveWalletKind(kind: WalletKind | null): void {
  activeWalletKind = kind;
}

export function getActiveWalletKind(): WalletKind | null {
  return activeWalletKind;
}

export function registerPrivyBridge(bridge: PrivyBridge | null): void {
  privyBridge = bridge;
}

/**
 * Registered by `PrivyWalletBridge` (only mounted when Privy is configured)
 * so UI outside the Privy provider tree, like the navbar, can trigger
 * login/logout without calling Privy's hooks directly.
 */
export function registerPrivyAuthControls(controls: PrivyAuthControls | null): void {
  privyAuthControls = controls;
}

export function getPrivyAuthControls(): PrivyAuthControls | null {
  return privyAuthControls;
}

export async function getAddress(): Promise<{ address: string; error?: WalletApiError }> {
  if (activeWalletKind === 'privy') {
    if (!privyBridge?.address) {
      return { address: '', error: 'Privy wallet not connected' };
    }
    return { address: privyBridge.address };
  }
  return FreighterApi.getAddress();
}

export async function requestAccess(): Promise<{ address: string; error?: WalletApiError }> {
  if (activeWalletKind === 'privy') {
    return privyBridge?.address
      ? { address: privyBridge.address }
      : { address: '', error: 'Privy wallet not connected' };
  }
  return FreighterApi.requestAccess();
}

/**
 * Signs a prepared transaction's XDR and returns `{ signedTxXdr, error? }`,
 * matching `@stellar/freighter-api`'s `signTransaction` shape exactly.
 *
 * Privy path: hashes the envelope client-side (Stellar's own signature-base
 * hash, not a re-hash of anything Privy does), gets a raw Ed25519 signature
 * over that hash via the registered `signRawHash`, and attaches it as a
 * decorated signature the same way hardware-wallet integrations do.
 */
export async function signTransaction(
  xdr: string,
  opts: { networkPassphrase: string; address?: string }
): Promise<{ signedTxXdr: string; signerAddress?: string; error?: WalletApiError }> {
  if (activeWalletKind === 'privy') {
    if (!privyBridge) {
      return { signedTxXdr: '', error: 'Privy wallet not connected' };
    }

    try {
      const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, opts.networkPassphrase);
      const hash = tx.hash();

      const { signature } = await privyBridge.signRawHash({
        address: privyBridge.address,
        chainType: 'stellar',
        hash: `0x${hash.toString('hex')}`,
      });

      const signatureBuffer = Buffer.from(signature.replace(/^0x/, ''), 'hex');
      tx.addSignature(privyBridge.address, signatureBuffer.toString('base64'));

      return { signedTxXdr: tx.toXDR(), signerAddress: privyBridge.address };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to sign transaction with Privy';
      return { signedTxXdr: '', error: message };
    }
  }

  return FreighterApi.signTransaction(xdr, opts);
}
