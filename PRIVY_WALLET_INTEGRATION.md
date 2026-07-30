# Privy Wallet Integration — How It Works, and How We Wired It Into Vanna

> **Purpose:** the single reference for *what Privy actually does, why Stellar gets a
> reduced feature set compared to Ethereum/Solana, and exactly how that reduced
> feature set was wired into Vanna alongside Freighter.*
>
> One-line version: **Privy gives most chains a full wallet (create + build + sign +
> send + policies + UI). Stellar only gets "create a key and sign a hash you hand it" —
> everything else, we built ourselves.**

---

## 1. What Privy is, in general

Privy (privy.io) is a wallet-as-a-service platform. Instead of asking every user to
install a browser extension (Freighter, MetaMask, Phantom...) and manage a seed
phrase, Privy lets a user log in with something familiar — email, Google, a passkey —
and Privy creates and custodies a real private key for them behind the scenes
("embedded wallet"). The app never sees the raw private key; it asks Privy's SDK to
sign things on the user's behalf, and Privy's infrastructure (secure enclaves +
Shamir's-secret-sharing key management) does the actual signing.

Privy supports many chains, but **not all chains get the same feature set**. Privy
groups chains into three support tiers:

| Tier | Chains | What you get |
| --- | --- | --- |
| **Tier 3** (full) | Ethereum/EVM, Solana, Tempo | Wallet creation, **transaction building**, gas sponsorship, smart-contract wallets, a built-in confirmation modal, a **policy engine** (allowlist contracts/spend limits), MFA |
| **Tier 2** ("extended chains") | **Stellar**, Cosmos, Sui, Aptos, Tron, Bitcoin, Near, Ton, Starknet, Movement | Wallet creation + **raw cryptographic signing only**. No transaction building, no confirmation UI, no policy engine, no MFA |
| **Tier 1** | everything else | Minimal key management only |

This tiering is the single most important fact for this whole integration: **Stellar
is Tier 2.** Everything below follows from that.

---

## 2. How Privy works on a Tier 3 chain (Ethereum/Solana) — for contrast

On Ethereum or Solana, Privy is a nearly complete wallet:

1. User logs in → Privy auto-creates an embedded wallet (`embeddedWallets.ethereum.createOnLogin`).
2. Your app calls a high-level method like `useSendTransaction()` with a plain
   `{to, value, data}` object — **Privy builds the transaction itself**.
3. Privy shows its **own confirmation modal** ("Send 0.5 ETH to 0x1234...? Confirm /
   Reject") before signing — this is the same UX role Freighter's popup plays for
   Stellar.
4. Optionally, a **policy** configured in the Privy dashboard can block the signature
   before it even reaches the user (e.g. "never allow calls to contract X", "cap spend
   at $500/day"), and MFA can be required for high-value actions.
5. Privy can even sponsor gas and submit the transaction for you.

None of steps 2–5 (transaction building, confirmation UI, policies, MFA, gas
sponsorship) exist for Tier 2 chains. That's not a bug in our integration — it's the
documented ceiling of what Privy currently offers for Stellar.

---

## 3. How Privy works on Stellar specifically (Tier 2 / "extended chains")

For Stellar, Privy gives you exactly two primitives, both from a separate SDK
entrypoint — `@privy-io/react-auth/extended-chains` (not the main package):

### 3.1 Creating the embedded wallet

```ts
import { useCreateWallet } from "@privy-io/react-auth/extended-chains";

const { createWallet } = useCreateWallet();
const { user, wallet } = await createWallet({ chainType: "stellar" });
```

There is **no automatic wallet creation on login** for Stellar (the
`embeddedWallets.ethereum.createOnLogin` shorthand only exists for Ethereum and
Solana). Your app has to call `createWallet` itself, once, right after the user logs
in.

Once created, the wallet shows up as an entry in `user.linkedAccounts`:

```ts
user.linkedAccounts.find(
  (a) => a.type === "wallet" && a.walletClientType === "privy" && a.chainType === "stellar"
);
// → { address: "G...", chainType: "stellar", walletClientType: "privy", ... }
```

This gives you a real Stellar `G...` address, backed by a real Ed25519 keypair that
Privy custodies (via secure enclave + key-sharding — the app never touches the
private key).

### 3.2 Signing — raw hash only, no XDR awareness

```ts
import { useSignRawHash } from "@privy-io/react-auth/extended-chains";

const { signRawHash } = useSignRawHash();
const { signature } = await signRawHash({
  address: "G...",
  chainType: "stellar",
  hash: "0x...", // a 32-byte hash, hex-encoded
});
// signature is also 0x-hex encoded, 64 raw Ed25519 signature bytes
```

Privy does **not** know what a Stellar transaction, a Soroban invoke-host-function
call, or an XDR envelope is. It signs whatever 32-byte hash you hand it, along the
Ed25519 curve, and hands back raw signature bytes. **Nothing else** — no transaction
building, no submission, no confirmation prompt, no policy check.

This means your app must own the *entire* pipeline: build the Stellar transaction,
compute its signature-base hash, ask Privy to sign that hash, glue the returned
signature back onto the transaction as a proper decorated signature, and submit it to
Horizon/Soroban RPC yourself. That's exactly what our integration does — see §4.

### 3.3 What Stellar does *not* get, compared to Tier 3

| Feature | Tier 3 (EVM/Solana) | Tier 2 (Stellar) |
| --- | --- | --- |
| Wallet auto-created on login | ✅ (`createOnLogin`) | ❌ manual `createWallet()` call |
| Transaction building | ✅ Privy builds it | ❌ your app builds the full XDR |
| Confirmation popup before signing | ✅ built-in modal | ❌ **none — signs instantly** |
| Policy engine (spend limits, allowlists) | ✅ | ❌ not supported for Stellar at all |
| MFA on signing | ✅ | ❌ not supported for Stellar at all |
| Gas sponsorship / smart wallets | ✅ | ❌ |

The missing confirmation popup is the one that matters most day-to-day: **Freighter
shows its own "approve this transaction?" popup because it's a separate browser
extension the app doesn't control. Privy's Stellar wallet has no equivalent — a call
to `signRawHash` signs immediately, with no user-facing prompt, because Tier 2 simply
doesn't have that feature yet.** If we want that safety net for Privy users, we have
to build it ourselves in Vanna's own UI (tracked as a follow-up, not yet built).

---

## 4. How we integrated this into Vanna

### 4.1 The constraint that shaped the design

Before this work, every wallet interaction was hardcoded to Freighter: 20+ call sites
across `lib/margin-utils.ts`, `lib/blend-utils.ts`, `lib/aquarius-utils.ts`,
`lib/soroswap-utils.ts`, `lib/faucet-utils.ts`, `lib/stellar-utils.ts`, and a few
components called `getAddress()` / `signTransaction()` from `@stellar/freighter-api`
directly. There was no abstraction layer to plug a second wallet into.

The approach: build one adapter that **exactly mirrors Freighter's own function
signatures**, so every existing call site only needs its import line changed — not its
logic.

### 4.2 The pieces

```
┌─────────────────────────────────────────────────────────────────────┐
│  components/navbar.tsx                                               │
│  "Connect Wallet" → dropdown: [ Freighter | Log in (Email/Google) ]  │
└───────────────┬───────────────────────────────┬─────────────────────┘
                │                               │
                ▼                               ▼
   connectWallet('freighter')          connectWallet('privy')
   (hooks/use-wallet.ts)                        │
                │                               ▼
                │                    getPrivyAuthControls().login()
                │                    (opens Privy's hosted login modal)
                │                               │
                │                               ▼
                │                  contexts/privy-wallet-bridge.tsx
                │                  - creates Stellar embedded wallet
                │                    (useCreateWallet) if none exists
                │                  - registers {address, signRawHash}
                │                    into the adapter singleton
                │                  - writes address/isConnected/
                │                    walletKind into store/user.ts
                ▼                               ▼
     ┌─────────────────────────────────────────────────────┐
     │            lib/wallet-adapter.ts (singleton)          │
     │  setActiveWalletKind('freighter' | 'privy' | null)    │
     │  getAddress() / requestAccess() / signTransaction()   │
     │  — same call shapes as @stellar/freighter-api         │
     └───────────────┬───────────────────────┬───────────────┘
                     │ kind === 'freighter'   │ kind === 'privy'
                     ▼                        ▼
         @stellar/freighter-api      1. parse XDR → tx.hash()
         (pass-through, unchanged)   2. signRawHash({chainType:'stellar', hash})
                                     3. decode hex sig → base64
                                     4. tx.addSignature(pubkey, sig)
                                     5. return { signedTxXdr: tx.toXDR() }
                     │                        │
                     └───────────┬────────────┘
                                 ▼
      lib/margin-utils.ts, blend-utils.ts, aquarius-utils.ts,
      soroswap-utils.ts, faucet-utils.ts, stellar-utils.ts
      — unchanged call sites, e.g.:
        const signResult = await signTransaction(xdr, {networkPassphrase});
        const signedTx = TransactionBuilder.fromXDR(signResult.signedTxXdr, ...);
```

**Files added:**

- **`lib/wallet-adapter.ts`** — the module-level singleton. Holds which wallet is
  currently "active" (`freighter` / `privy` / `null`) and, for Privy, a registered
  `{address, signRawHash}` bridge. Exports `getAddress`, `requestAccess`,
  `signTransaction` with the *exact same return shapes* Freighter's own SDK has
  (including its quirky `{error?}` field), so nothing downstream had to change except
  the import path.
- **`contexts/privy-provider.tsx`** — wraps `@privy-io/react-auth`'s `PrivyProvider`.
  Renders children unwrapped (Freighter-only) if `NEXT_PUBLIC_PRIVY_APP_ID` isn't set,
  so the app works even before Privy is configured.
- **`contexts/privy-wallet-bridge.tsx`** — a headless component (renders `null`)
  mounted inside the Privy provider tree. This exists because Privy's hooks
  (`usePrivy`, `useCreateWallet`, `useSignRawHash`) can only be called from inside
  React, but `lib/wallet-adapter.ts` is a plain module used by non-React code. This
  bridge calls the hooks and pushes their values into the adapter singleton and into
  `store/user.ts` via plain function calls, closing that gap.

**Files modified:**

- **`store/user.ts`** — added a persisted `walletKind: 'freighter' | 'privy' | null`
  field, so a page reload knows which wallet to reactivate.
- **`hooks/use-wallet.ts`** — `connectWallet(kind)` now branches: Freighter calls
  `WalletService.connectWallet()` (unchanged); Privy calls
  `getPrivyAuthControls().login()`, and the actual store update happens reactively
  inside the bridge once login + wallet creation finish.
- **`app/layout.tsx`** — provider tree now wraps `<AppPrivyProvider>` around the rest
  of the app.
- **`components/navbar.tsx`** — "Connect Wallet" became a 2-option dropdown; the
  connected-wallet label is now wallet-kind-aware ("Freighter Wallet" / "Privy
  Wallet") instead of hardcoded.
- ~10 files across `lib/` and 3 margin components — one import line changed each,
  from `@stellar/freighter-api` to `@/lib/wallet-adapter`.

### 4.3 Why the design works this way

- **Zero call-site rewrites.** Because the adapter mirrors Freighter's function
  signatures exactly, the 20+ places that call `signTransaction`/`getAddress` never
  needed to know which wallet is active — they just call the same function, and the
  adapter routes it.
- **The bridge pattern solves the "hooks vs. plain functions" mismatch.** Privy's SDK
  is hook-based (React-only); most of Vanna's wallet logic is plain TypeScript classes
  (`WalletService`, `ContractService`, etc.) called from anywhere. The bridge is the
  one place where a React component reads Privy's hook values and pushes them into a
  plain module-level variable that non-React code can read synchronously.
- **Privy is additive, never a replacement.** Freighter's code path is byte-for-byte
  unchanged; the adapter only branches into Privy-specific logic when
  `walletKind === 'privy'`.

---

## 5. Current limitations (read before trusting this with real funds)

1. **No confirmation popup for Privy signing** (see §3.3). A Privy-connected user's
   transactions sign the instant the app calls `signTransaction` — there is no "are
   you sure" step today. Freighter users still get their extension's native popup.
2. **The core cryptographic assumption is unverified live.** `lib/wallet-adapter.ts`
   assumes Privy's `signRawHash` signs the exact 32 bytes it's given, with no
   additional hashing. Privy's docs never state this explicitly for Stellar. It needs
   to be confirmed by signing one real throwaway transaction on testnet and checking
   Horizon/Soroban RPC accepts it, before this path is trusted for anything real.
3. **No Soroban auth-entry co-signing.** Vanna's contracts never call
   `signAuthEntry` today (every write signs a single outer envelope), so this wasn't
   built. If a future contract needs a separate signature over a Soroban
   authorization entry, the Privy path would need extending.
4. **No policy engine / spend limits / MFA for the Privy path** — not a Vanna gap,
   Privy simply doesn't offer these for Stellar yet (§3.3).

---

## 6. Where to look in the code

| Concern | File |
| --- | --- |
| Wallet-kind-agnostic sign/address adapter | `lib/wallet-adapter.ts` |
| Privy provider setup | `contexts/privy-provider.tsx` |
| Privy hooks → adapter/store bridge | `contexts/privy-wallet-bridge.tsx` |
| Connection state, `walletKind` | `store/user.ts` |
| Connect/disconnect logic | `hooks/use-wallet.ts` |
| Wallet-choice UI | `components/navbar.tsx` |
| Privy App ID | `.env` → `NEXT_PUBLIC_PRIVY_APP_ID` (get one at dashboard.privy.io) |
