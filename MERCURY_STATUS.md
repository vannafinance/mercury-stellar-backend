# Mercury Integration — Status & Final Contract Asks

> On-chain history/events migrated from RPC `getEvents` scraping to the Mercury indexer.
> Updated 2026-06-13. Audience: contract side (Rohit) — to settle the remaining upgrades.

---

## 1. Status at a glance

**Mercury migration is ~95% done.** 4 of 5 on-chain event hooks read from Mercury; only
Aquarius LP history is left. The contract events Rohit deployed (`Trader_Borrow.token_amount`
+ new `Trader_Deposit`, PR #31) are **live and verified** — margin history is now pure-Mercury.

| Event hook | Source now | Status |
| --- | --- | --- |
| `useMarginHistory` (margin borrow/repay/deposit) | Mercury (`getMarginHistoryFromMercury`) | ✅ Done — pure Mercury on the new contract |
| `useEarnTransactions` (lending supply/withdraw) | Mercury (`getEarnTransactionsFromMercury`) | ✅ Done (PR #29) |
| `useSoroswapEvents` (Soroswap LP) | Mercury (`getSoroswapLpEventsFromMercury`) | ✅ Done (PR #28) |
| `useBlendEvents` (Blend farm) | Mercury (`getBlendEventsFromMercury`) | ✅ Done (PR #32) |
| **`useAquariusEvents` (Aquarius LP)** | **RPC** (`AquariusService.getAquariusEvents`) | ⛔ **Left — see §3** |

---

## 2. What's complete (and how attribution works per source)

Every hook needs to filter events to one margin account. Each working hook has a per-account
handle:

- **Margin / Earn / Blend** — the account is in an event **topic** → Mercury filters server-side.
- **Soroswap** — the account is in the event **`data.to`** payload → we filter client-side.

All four are migrated, full-history (no ~7-day RPC cap), and timestamps come from **Horizon**
(`created_at` / `ledgerClosedAt`) where the event payload doesn't carry one.

---

## 3. What's left — `useAquariusEvents`, and WHY

The Aquarius AMM (a **third-party** contract) emits its LP events keyed by the **pool**, not the user:

```
deposit_liquidity / withdraw_liquidity
  topic1 = event name
  topic2 = pool token A      (e.g. AQUARIUS_USDC)
  topic3 = pool token B      (e.g. XLM)
  data   = [share, amountA, amountB]
```

**The depositor's address is in neither the topics nor the data.** So — unlike every other
source — there is no handle to attribute an Aquarius LP event to a margin account. (The old RPC
path has the same problem and effectively returns nothing, so this is *not* a Mercury regression.)

---

## 4. How we finish Aquarius — decision

**DECIDED: we need the contract event (Option B).** The Aquarius LP history/charts need the
**per-token amounts** (`amountA`/`amountB`), and the frontend-only fallback can't provide them.

**Option B — One contract event (CHOSEN).**
`AccountManager` emits a margin-side Aquarius LP event (details in §5.1). Then `useAquariusEvents`
reads it from Mercury, scoped by account, **with full amounts** — identical to the other hooks,
no client-side scale/dedupe caveats. **This is the ask for Rohit.**

**Option A — Frontend only (fallback / interim only).**
Our LP **tracking token** records the margin account in `data.to` + `token_symbol` + LP `amount`
on `mint`/`burn`, so we *could* attribute Aquarius LP client-side (Soroswap-style). But it gives
the **LP share amount only — no `amountA/amountB`**, plus an un-scoped fetch (scale) and a
mint/transfer dedupe gotcha. Usable as a stopgap if the contract event is delayed; not the target.

---

## 5. Final contract-side asks (for Rohit) — minimal, only what's needed

### 5.1 — (NEEDED) Emit a margin-side Aquarius LP event
On Aquarius add/remove-liquidity via `execute()`, emit from `AccountManager`:

```
Trader_AquariusDeposit  / Trader_AquariusWithdraw
  topic2 = smart_account
  data   = { smart_account, token_symbol, amount_a, amount_b, shares }
```

Same pattern as the `Trader_Deposit` you just added. **Reason:** the Aquarius pool event has no
depositor, so this is the only way to get clean per-account Aquarius history **with the per-token
amounts** the LP charts need. This is the one outstanding change required to finish the Mercury
migration. *(Bonus: a single unified `Trader_Farm` event covering Blend/Aquarius/Soroswap would
let all three farm hooks read one consistent source — nice-to-have, not required.)*

### 5.2 — (Pre-existing, non-Mercury) SoUSDC pool wiring
Confirm/fix the **SoUSDC (Soroswap-USDC) lending pool** registration/liquidity — borrow was
failing for that pair. Unrelated to Mercury; bundling here so it's on one list.

### 5.3 — (Optional / info) Repay can't cover accrued interest
Repay pulls funds **from the smart account**, which holds the borrowed principal but not the
interest that accrues on top — so a full repay leaves a sub-cent residual (we now cap the repay
at the account's balance and tell the user to top up a little to fully clear). If one-click full
repay is desired, the contract would need to pull the interest delta from the user's wallet.
**Decision needed only if you want full-repay UX; otherwise no action.**

---

## 6. What does NOT need contract work (please don't)

- **Timestamps.** Stellar auto-bundles `ledgerClosedAt` with every event; we read it from Horizon.
  Emitting a timestamp in event payloads is redundant/non-standard (Soroswap, Blend, Aquarius emit
  none) — **do not add timestamp fields**.
- **Borrow amount, deposits, repay** — all working from Mercury after PR #31. ✅

---

## 7. One-line summary to relay

> Mercury migration is done except Aquarius LP history. To finish it we **need** a
> `Trader_AquariusDeposit/Withdraw` event emitted from AccountManager (same shape as the
> `Trader_Deposit` you added: `{ smart_account, token_symbol, amount_a, amount_b, shares }`) —
> the Aquarius pool event has no depositor, so this is the only way to get per-account history
> **with the per-token amounts** the charts need. Separately: is the **SoUSDC pool** borrow wiring
> fixed? **No timestamp work needed anywhere** (we read ledger close time from Horizon).
