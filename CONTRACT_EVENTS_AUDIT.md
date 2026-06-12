# Contract Events Audit — emit gaps & indexer impact

> Verified on Stellar **testnet** via Mercury Classic REST + decoded XDR (2026-06-11).
> Purpose: tell the protocol team exactly which events/fields are missing for the
> Mercury-backed history & analytics, and answer "is emitting timestamps the right
> approach?" against industry norms.

---

## TL;DR

1. **`Trader_Borrow` is the one real contract bug.** It emits the asset symbol only —
   **no amount** — so borrow rows show `0.00` and need a localStorage amount overlay.
   **Emit `token_amount` on `Trader_Borrow`.** This is the highest-value fix. (Do **not**
   add a `timestamp` field — see the verdict; the ledger already carries `ledgerClosedAt`.)
2. **There is no deposit event on AccountManager.** Collateral deposits are invisible to
   any indexer; the UI can only show them from per-browser localStorage. **Emit a
   `Trader_Deposit` (collateral) event.**
3. **Emitting `timestamp` in the payload is NOT the industry norm** — but it's a
   *pragmatic* workaround for Mercury Classic's missing close-time. See the verdict below.
   Amount + account in events **are** mandatory and standard.

---

## Per-event matrix

Legend: ✅ present · ❌ missing · 🔑 in a **topic** (indexer can filter server-side) ·
📦 in **data** payload (not server-filterable) · **Ours** = Vanna contract (we can change it).

### Vanna AccountManager — `CCKJOXCB…` (Ours)

| Event | Account | Amount | Timestamp | Notes |
|---|---|---|---|---|
| `Trader_Borrow` | 🔑 topic2 | ❌ **missing** | ❌ **missing** | `data` = asset symbol string only |
| `Trader_Repay_Event` | 🔑 topic2 | ✅ `token_amount` (WAD 1e18) | ✅ `timestamp` | `data` = `{smart_account, token_symbol, token_amount, timestamp}` — **the model to copy** |
| `Smart_account_creation` | 🔑 | — | — | account lifecycle |
| **(deposit)** | — | — | — | ❌ **no event emitted at all** |

### Vanna LendingPool — 4 pools (`CBA4E4ZM…` XLM, `CABLEI2Z…` USDC, +Aquarius/Soroswap) (Ours)

| Event | Account | Amount | Timestamp | Notes |
|---|---|---|---|---|
| `deposit_event` | 🔑 topic2 | ✅ `amount` (WAD) | ✅ `timestamp` | `{amount, asset_symbol, lender, timestamp}` — **fully self-describing** |
| `withdraw_event` | 🔑 topic2 | ✅ `vtoken_amount` | ✅ `timestamp` | `{asset_symbol, lender, timestamp, vtoken_amount}` |
| `mint_event` / `burn_event` | 🔑 topic3 / topic2 | ✅ `token_amount` | ✅ `timestamp` | vToken supply changes |

> This is the gold standard in this codebase — earn history is **pure Mercury, zero
> external calls**, precisely because the payload is complete. `Trader_Borrow` should look
> like this.

### Soroswap pair — `CDVAIOYH…` (External — cannot change)

| Event | Account | Amount | Timestamp | Notes |
|---|---|---|---|---|
| `deposit` / `withdraw` (`topic1=SoroswapPair`) | 📦 `data.to` | ✅ `amount_0/1`, `liquidity` (1e7) | ❌ | account in payload → **no server-side scoping**; fetch all + filter client-side |
| `mint` / `burn` | 🔑 (partial) | ✅ shares | ❌ | `mint`→user in topic3, `burn`→pair (not user) |

### Aquarius pool — `CD3LFMML…` (External — cannot change)

| Event | Account | Amount | Timestamp | Notes |
|---|---|---|---|---|
| `deposit_liquidity` / `withdraw_liquidity` | ❌ **not present** | ✅ `[share, amountA, amountB]` (1e7) | ❌ | topics are the two **pool tokens**; depositor is nowhere → **not user-attributable** |

### Blend pool — `CCEBVDYM…` (External — cannot change)

| Event | Account | Amount | Timestamp | Notes |
|---|---|---|---|---|
| `supply` / `withdraw` | 🔑 topic3 | ✅ `[underlying, bToken]` (1e7) | ❌ | server-side scopable; timestamp via Horizon |

---

## What we must emit (prioritized, Vanna contracts only)

| # | Contract | Change | Impact |
|---|---|---|---|
| 1 | AccountManager | **`Trader_Borrow`: add `token_amount`** (WAD), shape like `Trader_Repay_Event` | Removes the localStorage amount overlay; borrow amounts correct for everyone, all devices |
| 2 | AccountManager | **Emit a deposit event** (`smart_account, token_symbol, amount`) | Deposits become indexable; removes the last localStorage dependency in margin history |
| 3 | AccountManager | Keep the account in a **topic** (it already is) on every new event | Preserves Mercury server-side per-account filtering |
| — | — | **Do NOT add `timestamp`** to any event | `ledgerClosedAt` is auto-bundled; recover it via Retroshade/Horizon — see verdict |

External pools (Soroswap/Aquarius/Blend) we can't change — for those, Horizon timestamps +
client-side filtering (or a Retroshade table) are the only options.

---

## Is emitting `timestamp` in events the right (industry) approach?

**Short answer: emitting `amount`/`account` — yes, always. Emitting `timestamp` — no, not the
industry norm; it's a pragmatic workaround, and there's a cleaner path.**

**The norm (EVM and Soroban):** events carry *semantic* data — amounts, addresses, ids — with
the searchable keys in indexed/topic position. They do **not** redundantly emit the block/ledger
time, because that already lives on the block/ledger and every indexer joins it.
- EVM: Uniswap/Aave/Compound `Mint`/`Borrow`/`Repay` events carry amounts + addresses, **never**
  `block.timestamp` — The Graph reads `block.timestamp`.
- Soroban: the mature protocols we probed — **Soroswap, Blend, Aquarius — emit no timestamp**;
  the ledger close time is expected to come from the ledger meta.

So Vanna's LendingPool emitting `timestamp` is already a **divergence** from the ecosystem norm.

**Why it nonetheless helped us:** Mercury *Classic* (the REST tier we're on) returns event rows
with **no ledger/close-time column**, and its GraphQL `event → tx → ledger → close_time` join is
broken on testnet. So the close time isn't reachable from the standard indexer surface — which is
exactly why the LendingPool's self-emitted `timestamp` let earn history be pure-Mercury, and why
borrows (no timestamp) need a Horizon `created_at` lookup.

**The cleaner, standard-aligned fix:** a **Retroshade** table (Mercury's custom-index tier) that
captures event data **+ `close_time`** from the close meta in one row → one query, no emitted
timestamp, no Horizon call. Federico recommended exactly this, scoped to the LendingPool
contracts (which also feed protocol risk metrics).

**Recommendation:**
- **Always** emit `amount` + `account` — non-negotiable, standard, and the actual gap on
  `Trader_Borrow`.
- **Do NOT emit `timestamp`.** Every Soroban event is auto-bundled with `ledger` +
  `ledgerClosedAt` (UNIX/ISO) by the host; a redundant `u64` in the struct just burns
  fees. Mature protocols (Soroswap/Blend/Aquarius) emit none. (Only exception: a *custom*
  future time like a vesting/unlock date — not the close time.)
- **Get the close time from the ledger, not the contract.** The catch specific to us:
  `ledgerClosedAt` is on the **Soroban RPC `getEvents`** response — but that API only retains
  **~7 days**. For full history via **Mercury Classic REST**, the row has **no time column**
  (verified) and the GraphQL join is broken. So surface `ledgerClosedAt` via:
  - **Retroshade** (preferred): a custom Mercury index that captures event data **+ `close_time`**
    from the ledger close meta → one query, no emitted timestamp, no external call. This is the
    "leverage indexers" path done correctly.
  - **Horizon `created_at`** (interim): per-tx lookup, full history. What margin/Soroswap/Blend
    do today via `lib/mercury-timestamps.ts`.
- **LendingPool already emits `timestamp`** — harmless and deployed, so leave it; just don't
  add timestamp emission to `Trader_Borrow` or any new event. The definitive mainnet interface
  should rely on `ledgerClosedAt`, not a payload field.
