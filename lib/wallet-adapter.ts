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
  /** Whether Privy already has a live session (calling `login()` then no-ops). */
  authenticated: boolean;
  /**
   * Re-applies the current Privy session's Stellar wallet to the wallet store.
   * Lets the connect flow recover a session that's still live in Privy but no
   * longer reflected in the store, without a redundant `login()` call.
   *
   * @returns true if an embedded Stellar wallet was found and synced.
   */
  resync: () => boolean;
  /**
   * The session's current Privy access token, refreshed by Privy as needed.
   *
   * Sent to our own API as the end-user assertion, which is how a copilot write
   * proves who is asking without a second login. Privy's SDK owns the refresh, so
   * always call this at request time rather than caching the string.
   */
  getAccessToken: () => Promise<string | null>;
  /**
   * Authorize a Vanna signer quorum on the session's embedded Stellar wallet.
   *
   * This is the consent that lets the Sign Service sign for the user, and it is the
   * ONLY step of the binding flow that must happen in the browser — Privy's SDK
   * holds the user's session, so nothing server-side can grant it on their behalf.
   *
   * `addSigners` ADDS the quorum alongside the user's own key (`ownerModel: "user"`);
   * ownership never transfers and the user can revoke it in Privy. Privy may show its
   * own confirmation sheet, which is acceptable — what is not acceptable is sending
   * the user to a different page to do this, since they are already authenticated
   * here.
   *
   * Idempotent: a wallet already showing `delegated` returns without re-prompting.
   */
  authorizeVannaSigner: (
    signerId: string,
  ) => Promise<{ address: string; delegated: boolean }>;
}

let activeWalletKind: WalletKind | null = null;
let privyBridge: PrivyBridge | null = null;
let privyAuthControls: PrivyAuthControls | null = null;

/** Resolvers waiting for `registerPrivyBridge` — see `awaitPrivyBridge`. */
let privyBridgeWaiters: Array<(bridge: PrivyBridge | null) => void> = [];

export function setActiveWalletKind(kind: WalletKind | null): void {
  activeWalletKind = kind;
}

export function getActiveWalletKind(): WalletKind | null {
  return activeWalletKind;
}

export function registerPrivyBridge(bridge: PrivyBridge | null): void {
  privyBridge = bridge;
  if (bridge) {
    const waiters = privyBridgeWaiters;
    privyBridgeWaiters = [];
    waiters.forEach((resolve) => resolve(bridge));
  }
}

/**
 * Resolve the Privy bridge, waiting for it if the session is still hydrating.
 *
 * `activeWalletKind` is set to `'privy'` from the *persisted* store the moment
 * the app mounts (and again on every window focus — see `useWallet`'s
 * `checkConnection`), but the bridge itself only lands once Privy reports
 * `ready && authenticated` and the embedded Stellar wallet shows up in
 * `user.linkedAccounts`. Between those two points the wallet is genuinely
 * connected — the navbar reads the same persisted store — yet a signing call
 * that resolved the bridge synchronously would see `null` and report the
 * wallet as disconnected. So wait briefly for registration instead of failing
 * on a race, and only give up if Privy never finishes hydrating.
 */
function awaitPrivyBridge(timeoutMs = 8000): Promise<PrivyBridge | null> {
  if (privyBridge) return Promise.resolve(privyBridge);
  // timeoutMs === 0 → return immediately (used by non-interactive reads).
  if (timeoutMs <= 0) return Promise.resolve(privyBridge);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (bridge: PrivyBridge | null) => {
      if (settled) return;
      settled = true;
      resolve(bridge);
    };
    privyBridgeWaiters.push(finish);
    setTimeout(() => {
      privyBridgeWaiters = privyBridgeWaiters.filter((w) => w !== finish);
      finish(privyBridge);
    }, timeoutMs);
  });
}

/** True when the active wallet should be driven through the Privy bridge. */
function isPrivyPath(): boolean {
  return activeWalletKind === 'privy' || (activeWalletKind === null && !!privyBridge?.address);
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

/**
 * The Privy access token for the current session, or null when there isn't one.
 *
 * The one place non-Privy code should get it: callers stay free of Privy hooks
 * (this module is imported from plain `lib/*.ts` too), and a missing bridge is a
 * null rather than a throw — a signed-out visitor's reads must not break.
 */
export async function getPrivyIdentityToken(): Promise<string | null> {
  const controls = privyAuthControls;
  if (!controls?.authenticated) return null;
  try {
    return await controls.getAccessToken();
  } catch {
    // Privy refuses when the session has lapsed. Treated as signed out: the write
    // falls back to wallet-sign, which is the behaviour without this entirely.
    return null;
  }
}

/** In-flight `requestAccess()` prompt, so concurrent callers can't stack popups. */
let pendingAccessPrompt: Promise<{ address: string; error?: WalletApiError }> | null = null;

/**
 * Resolve the active signing address.
 *
 * Freighter returns `{ address: '', error }` when the extension is locked or the
 * site is no longer authorized — a state the app can easily be in while the
 * navbar still shows an address (that comes from the persisted store).
 *
 * **`interactive` is opt-in and must stay that way.** `getAddress()` is called
 * from non-interactive read paths too — `getReadSourceAddress()` for simulation
 * fee sources, `WalletService.checkConnection()` on mount *and every window
 * focus*, and oracle price sims on every ledger close. Escalating to
 * `requestAccess()` there would fire the Freighter connect popup on page load,
 * on every ledger tick, and again each time the popup handed focus back. Only
 * pass `{ interactive: true }` from a path where the user just asked to sign.
 *
 * Privy race: `activeWalletKind` is often set to `'privy'` from the *persisted*
 * store before `PrivyWalletBridge` has registered the live signer. On interactive
 * calls we resync the bridge, wait briefly, then **fall back to Freighter** so
 * Approve & sign does not die with "Vanna wallet session is still not ready"
 * when the user actually has Freighter (or a late-hydrating Privy session).
 */
export async function getAddress(
  opts: { interactive?: boolean } = {}
): Promise<{ address: string; error?: WalletApiError }> {
  // ── Privy first when the session looks like Privy ───────────────────────
  if (isPrivyPath()) {
    // Kick the React bridge to re-apply linkedAccounts → adapter (no-op if already synced).
    if (opts.interactive) {
      try {
        privyAuthControls?.resync?.();
      } catch {
        /* ignore */
      }
    }

    // Interactive sign: short wait for bridge hydrate, then Freighter fallback.
    // Non-interactive reads: no hang (caller has fee-source fallback).
    const bridge = await awaitPrivyBridge(opts.interactive ? 3_000 : 0);
    if (bridge?.address) return { address: bridge.address };

    // Interactive: don't get stuck on a stale walletKind=privy — try Freighter.
    if (opts.interactive) {
      const freighter = await resolveFreighterAddress({ interactive: true });
      if (freighter.address && !freighter.error) {
        // Persist the working path so the next sign doesn't wait on a dead Privy flag.
        setActiveWalletKind("freighter");
        return freighter;
      }
      return {
        address: "",
        error:
          "Wallet session is still starting up. Wait a second and try again, or reconnect " +
          "(navbar → Connect). If you use Freighter, unlock it and authorize this site.",
      };
    }

    // Non-interactive: fail soft so sims use a fee-source fallback.
    return {
      address: "",
      error: "Vanna wallet session is still not ready — reload the page or sign in again.",
    };
  }

  return resolveFreighterAddress(opts);
}

async function resolveFreighterAddress(
  opts: { interactive?: boolean } = {},
): Promise<{ address: string; error?: WalletApiError }> {
  try {
    const direct = await FreighterApi.getAddress();
    if (direct?.address && !direct.error) return direct;

    const lockedDetail =
      describeWalletError(direct?.error) || "Freighter is locked or has not authorized this site.";
    if (!opts.interactive) return { address: "", error: lockedDetail };

    // Locked / not-yet-authorized for this origin → one explicit access prompt,
    // shared between concurrent callers so we never open two at once.
    pendingAccessPrompt ??= FreighterApi.requestAccess().finally(() => {
      pendingAccessPrompt = null;
    });
    const granted = await pendingAccessPrompt;
    if (granted?.address && !granted.error) return granted;

    return { address: "", error: describeWalletError(granted?.error) || lockedDetail };
  } catch (error) {
    return {
      address: "",
      error:
        error instanceof Error
          ? `Freighter unavailable: ${error.message}`
          : "No Stellar wallet detected. Install Freighter or sign in with Vanna wallet.",
    };
  }
}

/** Flatten Freighter's `string | { message }` error shape into a display string. */
function describeWalletError(error: WalletApiError | undefined): string | null {
  if (!error) return null;
  if (typeof error === 'string') return error;
  return error.message ?? null;
}

export async function requestAccess(): Promise<{ address: string; error?: WalletApiError }> {
  // Same recovery path as interactive getAddress — don't stick forever on a
  // half-hydrated Privy session when Freighter can authorize immediately.
  return getAddress({ interactive: true });
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
  // Prefer a live Privy bridge; if kind says privy but bridge never arrives,
  // fall through to Freighter so Approve & sign still works.
  if (isPrivyPath()) {
    try {
      privyAuthControls?.resync?.();
    } catch {
      /* ignore */
    }
    const bridge = await awaitPrivyBridge(3_000);
    if (bridge) {
      try {
        const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, opts.networkPassphrase);
        const hash = tx.hash();

        const { signature } = await bridge.signRawHash({
          address: bridge.address,
          chainType: "stellar",
          hash: `0x${hash.toString("hex")}`,
        });

        const signatureBuffer = Buffer.from(signature.replace(/^0x/, ""), "hex");
        tx.addSignature(bridge.address, signatureBuffer.toString("base64"));

        return { signedTxXdr: tx.toXDR(), signerAddress: bridge.address };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to sign transaction with Privy";
        // Fall through to Freighter only if Privy signing itself blew up and Freighter might work.
        console.warn("[wallet-adapter] Privy sign failed, trying Freighter:", message);
      }
    } else {
      console.warn("[wallet-adapter] Privy bridge not ready on sign — falling back to Freighter");
      setActiveWalletKind("freighter");
    }
  }

  return FreighterApi.signTransaction(xdr, opts);
}
