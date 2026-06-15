# Sprint 2 — Candidate Backlog

> Items deferred out of Sprint 1 v3.1. **This is a backlog, not a day-by-day plan** —
> it gets scoped into days when S2 actually kicks off (after v3.1 lands on `main`).
> Each item cites where it came from so nothing here is invented scope.
>
> Sources: SPRINT_1_GUIDE.md "STILL deferred post-v3.1" + scaling tables, CLAUDE.md
> open-debt notes, MERCURY_STATUS.md contract asks, and decisions logged during S1 D20–D22.

---

## Readiness key

- 🟢 **Ready** — frontend-only, no external/contract dependency; can start day 1 of S2.
- 🟡 **Blocked-on-contract** — needs the protocol/Soroban side first.
- 🔵 **Pre-mainnet** — only matters once we move off testnet.

---

## 1. Analytics island — deeper rework 🟢

S1 D22 (PR #33) did the **data layer**: ledger-tick + React Query, bounded the all-accounts
RPC scan, retired the bespoke store. Explicitly punted to S2 (user call, 2026-06-15: *"we will
later improve this analytics page in another sprint"*):

- **Mercury-ify / Hubble-back the live event feeds** — `readLiveEventFeed` (liquidations + whale
  activity) still RPC-scrapes a ~24h window (`lib/analytics/stellar/eventFeed.ts`). Move to full
  history via Mercury (un-scoped, protocol-wide) or Hubble aggregates. Lower priority: these
  panels only show the most recent ~25–40 rows, so the win is consistency, not user-visible depth.
- **Render-perf pass** — memoize `lib/analytics/onchain/derivations.ts`, profile
  `components/analytics/positions/PositionsMonitor.tsx`, fix `BadDebtMonitorSummary.tsx` per-render
  derivation. (Was D25 Dev B's tail; carry over anything not finished.)
- **UX / visual improvements** to the dashboards themselves.
- Note: `lib/analytics/oracle-agents/store.ts` `setInterval(3s)` stays — it's a client-side
  fixture animation (zero network), allowlisted.

## 2. Mercury — finish + scale

- **`useAquariusEvents` → Mercury** 🟡 — blocked on `AccountManager` emitting
  `Trader_AquariusDeposit/Withdraw { smart_account, token_symbol, amount_a, amount_b, shares }`
  (the Aquarius pool event has no depositor). The single outstanding ask in MERCURY_STATUS.md §5.1.
  *If Rohit's event lands during S1, this flips to S1; otherwise it's the first S2 Mercury item.*
- **Retroshade per-account tables** 🔵 — restores server-side per-account scoping at mainnet scale
  and removes the per-tx Horizon timestamp round-trips (close-time captured in the table). Decided
  off-the-table for S1 (per-tx Horizon is the permanent S1 approach); revisit for mainnet volume.
- **Mercury Builder tier ($79/mo)** 🔵 — testnet is free; mainnet needs the paid tier.

## 3. Edge cache / snapshot layer 🟢

- S1 **D25** landed the per-user (`/api/account/[addr]`) + per-pool (`/api/pools`) snapshot caches.
- The broader **protocol-wide `/api/snapshot`** edge cache (original S3 item) is still S2.
  (SPRINT_1_GUIDE deferred table, row S3.)

## 4. Token prices — collapse the dual API 🟢

D12 leftover (CLAUDE.md "Open debt"). The poll is gone and both readers hit the same oracle, but
the **duplicate API shape** remains:
- Retire `contexts/price-context.tsx` (`PriceProvider`) in favour of `hooks/use-token-prices.ts`.
- Migrate the 7 dual importers (earn `acitivity-tab`/`details-tab`/`margin-managers-tab`/
  `your-positions`; margin `borrow-box`/`collateral-box`/`transfer-collateral`).
- Until done: **do not add new `PriceProvider` consumers.**

## 5. Dead-code cleanup 🟢

- Remove the now-unused `appendMarginHistory` writes + `getMarginHistoryByAccount`
  (`lib/margin-history.ts`) — margin history is pure-Mercury after S1 D21.

## 6. Contract-side asks 🟡 (protocol team / Soroban dev)

- **`ProtocolViewContract` (compressor)** — needs a Soroban dev not on the v3.1 team
  (SPRINT_1_GUIDE deferred table, row S2).
- **Full-repay UX** — repay pulls from the smart account (principal only), leaving a sub-cent
  interest residual; we cap-and-notify today. One-click full repay needs the contract to pull the
  interest delta from the user's wallet (MERCURY_STATUS.md §5.3).
- **SoUSDC pool borrow wiring** — confirm/fix the Soroswap-USDC lending-pool registration/liquidity;
  borrow was failing for that pair (MERCURY_STATUS.md §5.2). Unrelated to Mercury.

## 7. Type-safety pass 🟢

Cut from v3.1 to make room for Mercury+Hubble; folded into reviewer discipline meanwhile
(SPRINT_1_GUIDE deferred table). A dedicated `any`-elimination / strictness pass is an S2 candidate.

## 8. Production / mainnet (original S6) 🔵

Production infra, 2× RPC HA, load test, mainnet config. Pre-mainnet concern — v3.1 is testnet-only
(SPRINT_1_GUIDE deferred table, row S6).

---

## Suggested first-week ordering (when S2 starts)

The 🟢 items have no external dependency and are the natural opener:
1. Dual `useTokenPrices` collapse (#4) + dead-code cleanup (#5) — small, closes long-standing debt.
2. Analytics render-perf + event-feed history (#1).
3. `useAquariusEvents` (#2) the moment the contract event exists.

🔵 mainnet items (#2 Retroshade/$79, #3 broader cache, #8 infra) wait until a mainnet date is set.
