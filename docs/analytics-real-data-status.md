# Analytics Real Data Status (Stellar / Soroban)

Last updated: 2026-05-09

This document tracks which analytics surfaces are now backed by **real on-chain data** (direct Soroban RPC calls, no indexer), and where fallback mock data is still used.

---

## Live Data Sources Wired

- **Pool stats (live RPC)**
  - Source: lending pool contracts via `ContractService.getPoolStats()`
  - Methods used: `get_total_liquidity_in_pool`, `get_borrows`, `total_supply` (vToken), derived utilization.
  - Used by: Overview/Oracles/Alerts data adapters.

- **Oracle prices (live RPC)**
  - Source: Reflector via `OracleContract.get_price_latest`
  - Adapter: `lib/analytics/stellar/rpcReader.ts` (`readOracleSnapshot`)
  - Includes stale/fallback detection per asset.

- **Connected wallet / margin account (live RPC)**
  - Source: margin account + pool + price reads through `margin-account-info-store`
  - Provides: collateral/debt balances, health factor, debt/collateral USD.

- **Soroban event feed (live RPC events, no contract changes)**
  - Adapter: `lib/analytics/stellar/eventFeed.ts`
  - Topics consumed:
    - `Trader_Liquidate_Event`
    - `Trader_Borrow`
    - `Trader_Repay_Event`
    - `Smart_account_creation`
    - `deposit_event`, `withdraw_event` (pool events)

---

## Page-by-Page Status

## `app/analytics/overview2/page.tsx`
- **Real now**
  - Protocol overview cards from live snapshot derivations (`useAnalyticsOnchainStore` + derivations).
  - HF/leverage distributions and margin composition from live snapshot data.
- **Fallback**
  - Mock dataset auto-used if no live account snapshot is available.

## `app/analytics/oracles/page.tsx`
- **Real now**
  - Reflector asset prices from live RPC (`readOracleSnapshot`), polled.
  - Live status strip: heartbeat target + stale feed count + live/mock indicator.
- **Fallback**
  - Mock oracles data if RPC misses/fails.

## `app/analytics/alerts/page.tsx`
- **Real now**
  - Connected wallet HF-based alerts.
  - Reflector stale/fallback alerts.
  - Pool utilization stress alerts.
  - RPC availability alert.
  - Live/mock source badges in alert cards.
- **Fallback**
  - Existing mock alert feed remains merged as secondary fallback.

## `app/analytics/whales/page.tsx`
- **Real now**
  - Whale concentration/top positions derived from live account snapshots.
  - Whale activity feed from live Soroban events (`eventFeed.ts`).
  - Live status strip for both concentration + activity sources.
- **Fallback**
  - Mock concentration/activity if live snapshot/event feed unavailable.

## `app/analytics/liquidations/page.tsx`
- **Real now**
  - Eligible wallets table from live snapshot positions where HF < 1.1.
  - Live bad debt estimate from current eligible set (approx recovery model).
  - Recent liquidation events from live Soroban event feed.
  - KPI count/success metrics use live history when available.
- **Fallback**
  - Mock liquidation history + KPI values when event feed unavailable.

---

## Event-Driven Feed Notes (Current Limits)

- This implementation uses **Option 1**: no smart contract changes.
- Some event payloads are currently minimal (for example liquidation event does not include full debt/recovery fields), so those columns may remain approximate/zero unless enriched by extra calls.
- Feed is still real-time event-driven; data richness depends on emitted contract payloads.

---

## Still Mock / Synthetic by Design

- Risk Explorer scenario simulation outputs (what-if engines) remain synthetic by design.
- Global full-history analytics remain constrained by RPC event retention window and absence of full public account-enumeration getters on contracts.

---

## Files Added/Updated for Real Data Integration

- `lib/analytics/stellar/rpcReader.ts`
- `lib/analytics/stellar/eventFeed.ts`
- `app/analytics/oracles/page.tsx`
- `app/analytics/alerts/page.tsx`
- `app/analytics/whales/page.tsx`
- `app/analytics/liquidations/page.tsx`
- `app/analytics/overview2/page.tsx`

