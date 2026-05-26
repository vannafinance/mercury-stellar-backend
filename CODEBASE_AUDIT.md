# Codebase Audit — Sprint 1 v3.1 (performance / reactivity / correctness / UX)

> Branch: `feat/stellar-rewire`. Audited 2026-05-27, after the `new-contract-update`
> re-sync (PR #13). Purpose: stop discovering issues one at a time — find every
> latent scenario that hurts the "upgraded app" and make sure the sprint plan covers
> it (or explicitly defers it) before EOD 2026-06-17.

## TL;DR

The 18 read **hooks** migrated in D8–10 (`use-{earn,margin,farm,soroswap}.ts`,
`use-token-prices.ts`) are clean — stable queryKey + invalidate-on-tick, `isLoading`
only, no `refetchInterval`. **Every remaining issue clusters in three places that the
hook migration never touched:**

1. **Margin Zustand path** — `store/margin-account-info-store.ts` is imperative, off
   React Query, with a 3-stage sequential await chain. This is the slow Margin stats
   cold-load.
2. **Farm / repay / lite mutation+read components** — imperative `useEffect → service
   → setState` reads (duplicating existing hooks), manual post-tx refresh calls.
3. **The entire analytics surface** — a pre-rewire island: bespoke imperative store,
   5 pages on 30s `setTimeout` polling, an unbounded all-accounts × per-token RPC
   fan-out.

**Decision (2026-05-27): the analytics rework is pulled INTO Sprint 1**, riding the
Mercury (D20–22) + Hubble (D23–24) work that already targets analytics. See "Schedule
impact" for the honest cost + the drop-first buffer that protects D30.

---

## Findings by category

Severity: **HIGH** = user-visible slow/broken/flicker · **MED** = inefficiency/tech-debt
· **LOW** = minor. File refs are from `feat/stellar-rewire` at audit time.

### A. Slow cold-load / RPC waterfalls
- **HIGH** `store/margin-account-info-store.ts` `refreshBorrowedBalances` — after the
  initial `Promise.all`, runs 3 more **sequential** awaits (farm-tracking merge →
  SAC reconcile → `getPoolStats` borrow rate). Root cause of the slow Margin stats bar.
- **HIGH** `hooks/use-earn.ts` `useUserPositions` — 3 serial `Promise.all` waves (12
  RPC); wave 2 re-fetches pool stats `usePoolData` already has.
- **MED** `components/margin/repay-loan-tab.tsx` — mount-time debt then wallet-balance
  awaited sequentially; all-token read on each currency change.
- **MED** `components/margin/leverage-assets-tab.tsx` — WB pre-submit + post-tx
  `refreshBorrowedBalances` awaited serially.

### B. Imperative chain reads not on React Query (re-fetch every mount, no tick, no dedupe)
- **HIGH** `components/farm/add-liquidity.tsx` — 5 `useEffect`s fetching pool config +
  stats + balances into `useState` (duplicates `useAllAquariusPoolStats` /
  `useSoroswapPoolStats`).
- **HIGH** `components/farm/remove-liquidity.tsx` — Blend/LP balances into `useState`
  (duplicates `useSoroswapLpPosition` / `useAquariusLpPosition`).
- **HIGH** `lib/analytics/onchain/store.ts` + every `app/analytics/*` page — analytics
  data in a bespoke Zustand store loaded via `useEffect`, off RQ + off tick.
- **MED** `components/lite-mode/one-click-strategy.tsx` — `fetch("/api/prices")` once
  on mount, never refreshes.
- **MED** `SwapCard.tsx`, `transfer-collateral.tsx`, `lite-mode/position-detail.tsx`
  — imperative balance reads / store refresh.

### C. Remaining polling
- **HIGH** `app/margin/page.tsx` — `useSmartPolling(…, 15_000)`. *(D12)*
- **HIGH** `contexts/price-context.tsx` — 60s `setInterval`. *(D12)*
- **MED ×5** `app/analytics/{oracles,alerts,whales,liquidations,risk-explorer}/page.tsx`
  — self-rescheduling `setTimeout(pull, 30_000)` loops (evaded earlier `setInterval`
  greps), not on the tick. **Was a gap — now pulled into S1 analytics rework.**
- Allowlisted (NOT chain data, leave): `carousel.tsx`, `analytics/layout/Header.tsx`
  (clock), `oracle-agents/store.ts` (simulation), `faucet-popup.tsx` (countdown).

### D. Competing / duplicate data systems
- **HIGH** Dual `useTokenPrices` — `@/contexts/price-context` (60s poll) vs
  `@/hooks/use-token-prices` (tick); 6 files import both (second aliased
  `useTokenPricesFromHook`). *(D12)*
- **HIGH** Margin data: Zustand store vs RQ — `app/page.tsx` invalidates `['margin']`
  AND imperatively calls `refreshBorrowedBalances` each tick (two refresh paths).
  *(D25/D26)*
- **MED** Earn store dual-write — `usePoolData`/`useUserPositions` write
  `useEarnPoolStore` + `useUserStore` while also being the RQ source. *(D26)*
- **MED** Farm pool stats fetched twice (component imperative vs hook). *(D11)*

### E. Loading flicker
- **MED** `app/margin/page.tsx` — header spinners + "Fetching latest data…" gated on
  `isLoadingBorrowedBalances`, which flips true on every poll → re-appears each refresh.
  (The main stats block is correctly gated on `noDataYet`.) *(D12/D25)*
- The 18 RQ hooks are clean — no `|| isFetching`, verified.

### F. Unbounded reads / localStorage hacks
- **HIGH** `lib/analytics/stellar/allMarginAccounts.ts` — reads the entire accounts
  Vec, then fans out per-account + per-token RPC (`1 + N + N + N×(2+cols+debts)`).
  Code admits "fine for testnet's few-dozen accounts." **Replaced by Mercury/Hubble in
  the S1 analytics rework.**
- **MED** localStorage history merges (`use-margin.ts`, `app/earn/page.tsx`,
  `lib/*-history.ts`) — cross-wallet contamination acknowledged in comments.
  *(D21 — Mercury replaces the localStorage merge.)*

### G. Heavy re-renders / per-tick recompute
- **MED** `components/margin/positions-table.tsx` — large `useMemo` (dedup + history
  scan + interest accrual) recomputes every ~5s tick; the computed `interestAccrued`
  is then **discarded** (UI hardcodes `$0`). Dead per-tick compute. *(D25 — delete it.)*
- **MED** `lib/analytics/onchain/derivations.ts` + `app/analytics/overview2` — derive
  over all snapshots in render. *(D25 memoization.)*
- **LOW** `hooks/use-earn.ts` `useEarnPage` — weighted-APY/total reduces in render body.

### H. Mutation gaps (manual refresh instead of pure invalidate)
- **HIGH** `components/margin/leverage-assets-tab.tsx` — WB deposit+borrow flow is a
  hand-rolled async handler, **not `useMutation`**; 4 manual `refreshBorrowedBalances`
  sites. *(D16–17.)*
- **HIGH** `farm/add-liquidity.tsx` + `remove-liquidity.tsx` — `onSuccess` invalidates
  `['farm']` but ALSO calls `refreshDexMarginBalances` + `refreshBorrowedBalances` +
  `triggerBlendRefresh` + manual `setState`; one path wrapped in a 3s `setTimeout`.
  *(D11 for `triggerBlendRefresh`; manual refreshes folded into D11/D26.)*
- **MED** `repay-loan-tab.tsx` — invalidates `['margin']` then awaits 3 manual
  refreshes. *(D26.)*
- `app/farm/[id]/page.tsx` + `store/blend-store.ts` `triggerRefresh`. *(D11.)*

### I. Error-handling gaps (swallowed failures → user sees wrong data, no signal)
- **MED** `margin-account-info-store.ts` — farm-merge / SAC-reconcile / borrow-rate
  failures only `console.warn`; user sees wrong HF/collateral silently. *(fold into D16–17.)*
- **MED** `farm/*` + `one-click-strategy.tsx` — `.catch(() => {})` on post-tx refresh /
  price fetch hides failures (stale balances, `{XLM:1,USDC:1}` placeholder pricing).
- **MED** `lib/analytics/stellar/*` — `fetchTokenPrices().catch(() => undefined)` and
  `simulateView`/owner reads swallow errors → wrong USD totals / silently dropped
  accounts. *(S1 analytics rework.)*
- **LOW** `navbar.tsx` clipboard `.catch(() => {})` — benign, leave.

### Doc/process nits (quick, high-leverage)
- `contexts/ledger-subscriber.tsx` JSDoc still tells devs to put `tick` in the queryKey
  — the exact anti-pattern CLAUDE.md bans. Fix to prevent copy-paste regressions. *(D12.)*
- Confirm whether `app/margin/page.tsx` or `app/page.tsx` is the shipping margin page —
  `app/margin/page.tsx` is a second, still-polling copy.

---

## Triage → where each item lands

| # | Item | Cat | Day | Note |
|---|---|---|---|---|
| 1 | Parallelize `refreshBorrowedBalances` await chain | A | **D25** | with snapshot cache |
| 2 | `useUserPositions` 3-wave → 1-wave + cache reuse | A | **D25** | |
| 3 | Margin stats off Zustand → snapshot-cache RQ hook | A/D | **D25** | `/api/account/[addr]` |
| 4 | Pool stats off Zustand → `/api/pools` RQ hook | A/D | **D25** | |
| 5 | Delete `positions-table` dead per-tick interest compute | G | **D25** | |
| 6 | Analytics derivation memoization | G | **D25** | |
| 7 | Kill `useSmartPolling` + `PriceProvider` poll + dual `useTokenPrices` | C/D | **D12** | |
| 8 | Fix `ledger-subscriber` JSDoc anti-pattern | nit | **D12** | trivial |
| 9 | Farm add/remove-liquidity: drop duplicate imperative reads + manual refresh; `triggerBlendRefresh` teardown | B/D/H | **D11** | files already touched |
| 10 | `repay-loan-tab` imperative reads + post-tx manual refresh | A/B/H | **D26** | |
| 11 | `leverage-assets-tab` WB flow → `useMutation` | H | **D16–17** | |
| 12 | Margin store read-error surfacing | I | **D16–17** | with error normalizer |
| 13 | localStorage history → Mercury | F | **D21** | Mercury replaces merge |
| 14 | **Analytics island**: 5 polling pages + bespoke store → RQ/tick; route event/aggregate reads through Mercury/Hubble; retire `allMarginAccounts` unbounded fan-out; analytics error handling | B/C/F/I | **D20–24** | rides Mercury/Hubble; see below |

### Deferred to Sprint 2 (realistic — NOT in S1)
- **Scaling the all-accounts roster beyond testnet** — once `allMarginAccounts` is on
  Mercury/Hubble (item 14), the *further* scaling (server pagination, edge cache of the
  roster for thousands of accounts) is a mainnet-era concern → S2.
- **List virtualization** for analytics tables — fine at current scale; S2 when rows grow.

---

## Schedule impact (honest)

Pulling the full analytics rework into S1 (item 14) is **~3–4 dev-days of work**. It is
NOT free. It lands where it's cheapest — on top of Mercury/Hubble (D20–24), which
already migrate analytics event/aggregate reads. Concretely:
- **D22** (Mercury analytics migration) expands to own: liquidations + whales +
  positions + bad-debt pages → Mercury queries; retire `allMarginAccounts` unbounded
  read; migrate the bespoke analytics store onto RQ.
- **D23–24** (Hubble) already deliver the `/stats` aggregate pages.
- **The 5 `setTimeout` polling pages** (oracles/alerts/whales/liquidations/risk-explorer)
  → ledger-tick or Mercury/Hubble-backed, folded into D22.

This pressures the back half. **Drop-first buffer to protect D30** (in priority order):
1. `ARCHITECTURE.md` (D27) → defer post-sprint if needed.
2. Analytics derivation memoization (D25 item 6) → defer (correctness already fine).
3. Mercury low-priority entities (Aquarius/Soroswap LP events) → stay on RPC.

**Hard requirements that cannot drop:** ledger-tick reactive layer (D8–12), stats
snapshot cache (D25), Mercury `Trader_*` + margin history (D21), Hubble `/stats` TVL +
liquidations (D24), analytics off 30s-polling (D22), 4-pool e2e (D29), merge to main (D30).

---

## What "done" looks like (EOD 2026-06-17)
- `grep -rn "refetchInterval" hooks/ app/` → empty
- `grep -rn "setInterval\|setTimeout(.*30_000\|setTimeout(.*30000" app/analytics/` → empty (only allowlisted UI timers remain)
- `grep -rn "refreshKey\|triggerRefresh" .` → empty
- `grep -rn "refreshBorrowedBalances\|refreshAllBalances" components/ app/` → empty (mutations pure-invalidate)
- Every stats panel (Margin/Earn/Farm/Portfolio/Analytics) renders < 1s on warm cache, updates ~5s post-tx, no flicker
- Analytics pages read from Mercury/Hubble/tick, not unbounded RPC or 30s polling
- `npm run lint && npm run build && npm run test` green
