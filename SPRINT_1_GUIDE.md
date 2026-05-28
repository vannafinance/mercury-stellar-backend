# Sprint 1 Plan — Stellar Integration Upgrade & Optimization (30-Day, 2-Dev Split)

> **Sprint 1 v3 — Vanna Backend Implementation**
> **Duration:** 30 calendar days · **Start:** 2026-05-19 · **Target end:** 2026-06-17
> **Team:** Phase 1 (Days 1–7) — Sanujit solo · Phase 2 (Days 8–30) — Sanujit (Dev A) + Rohit (Dev B) in parallel
> **Goal:** Zero `setInterval` for chain data. Zero `refetchInterval`. Ledger-tick drives every read. Every mutation migrated to `useMutation` with `onSuccess: invalidateQueries`. Plus: test infrastructure, optimistic updates, analytics perf, dual-write consolidation, type safety.
> **Companion doc:** [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
> **Trunk:** `main` of mercury-stellar-backend (merged with Stellar_frontend's `new-contract-update` on 2026-05-19 via merge commit `7c25ac7`; carries multi-pool contracts XLM/USDC/AQUARIUS_USDC/SOROSWAP_USDC, Reflector oracle, Risk Dashboard, the HF/net-earning fix, one-click APY-live, Blend liquidity HF bug fix, and LP-token deposit tracking fix). **Re-synced 2026-05-27** with `new-contract-update` through `de77db7` (PR #13 into `feat/stellar-rewire`): BigInt collateral math, Aquarius reserve-order fix, positions/repay calc updates, `capAmountToMaxBalance`. The sync also added a polling `PriceProvider` — see D12.
> **Notion source of truth:** https://www.notion.so/Sprint-1-Plan-Frontend-Rewire-2-Dev-Split-36042874c59b80e7a81fdec4d85eb0d7

---

## 🚦 Status — updated 2026-05-27

- **Phase 1 (D1–7):** ✅ complete (PR #10 merged 2026-05-25).
- **D8–10 hook tick migration:** ✅ complete. PR #11 (earn+margin) + PR #12 (farm+soroswap) merged into `feat/stellar-rewire`. 18 read hooks on the stable-queryKey + invalidate-on-tick pattern. `refetchInterval` count: **0**. `isLoading || isFetching`: **0**.
- **Sync (PR #13, 2026-05-27):** ✅ merged. `new-contract-update` @ `de77db7` layered under the rewire; build green, calc changes manually verified.
- **D11 — complete (2026-05-27).** `refreshKey`/`triggerRefresh` fully deleted: `store/blend-store.ts` removed; all call-sites in `app/farm/[id]/page.tsx`, `components/farm/add-liquidity.tsx`, `components/farm/remove-liquidity.tsx` cleared. `grep -rn "refreshKey|triggerRefresh" .` → empty. PR `s1/cleanup-refreshkey`.
- **D12 — complete (2026-05-27).** All remaining polling killed: `lib/hooks/useSmartPolling.ts` deleted; `app/margin/page.tsx` migrated to ledger-tick `useEffect` pattern; `contexts/price-context.tsx` 60s `setInterval` replaced with tick-driven refresh (sync debt resolved); JSDoc anti-pattern fixed in `contexts/ledger-subscriber.tsx`; `contexts/query-provider.tsx` updated. `grep -rn "setInterval" contexts/` → empty. PR `s1/cleanup-smartpolling`.
- **New scope pulled into S1 (→ D25):** stats snapshot-cache layer (`/api/account/[addr]` + `/api/pools`) — the real fix for the slow cold-load of **all** stats panels (Margin, Earn, Farm, Portfolio), not just margin. Was deferred to S2/S3; pulled in so every stat fetches fast by EOD. Reuses Hubble's edge-API patterns; parallel across both devs.
- **Codebase audit (2026-05-27):** full health audit done — see [CODEBASE_AUDIT.md](CODEBASE_AUDIT.md). Hook layer (D8–10) is clean; all remaining issues cluster in the margin Zustand path, farm/repay/lite components, and the analytics island. Items folded into D11/D12/D16–17/D22/D25/D26 with a drop-first buffer. **The full analytics-island rework (5 polling pages + bespoke store + unbounded all-accounts read) is pulled into S1 (D22)**, riding Mercury/Hubble.
- **D13–15 — complete (2026-05-29).** vitest v4 + happy-dom + RTL set up. 80 tests passing across 7 files: `computeBorrowApr` (8), `swap-amount` utils (19), `BlendService._parseReserveData` + `buildExternalProtocolCallBytes` (17), `ContractService.getPoolStats` (6), `MarginAccountService` error-message helpers (21), `useLedgerTick` SSE (5), `usePoolData` tick-invalidation (4). `npm run test` scripts wired. PR `s2/test-infra-services`.
- **Next:** D16–17 (unified mutation error/toast UX).
- **Pattern source of truth:** repo [CLAUDE.md](CLAUDE.md) §1–3. (The "Hook tick pattern" recipe lower in this doc shows the superseded `tick`-in-queryKey form — use CLAUDE.md.)

---

## What Changed in v3

v2 of this doc (2026-05-14) was a 5-day plan for 2 devs working in parallel. v3 stretches that to **30 days** for two reasons:

1. **Dev B unavailable for first 7 days** — Sanujit (Dev A) owns the entire foundation + mutation surface solo before Rohit (Dev B) joins on Day 8.
2. **Scope expansion** — original 6-sprint roadmap compressed into this single 30-day sprint: test infra, unified error UX, optimistic updates, analytics perf, dual-write consolidation, type safety pass, and documentation.

**Mutation strategy stays per v1/v2: full `useMutation` migration.** This decision is locked.

---

## What's IN v3.1 vs What's Deferred

**v3.1 update (2026-05-19, late):** Mercury indexer + Hubble analytics promoted from "deferred" → "in v3.1 Phase 2". Both start on **free tiers** (no payment decision needed). Adapted to current codebase (multi-pool: XLM/USDC/AQUARIUS_USDC/SOROSWAP_USDC).

### IN v3.1 — Phase 2 scope

| Item | Where | Free-tier OK? | Adapted for current code |
| --- | --- | --- | --- |
| Hook tick migration (refetchInterval → ledger tick) | D8–10 | n/a | ✅ shipped — PR #11 + #12 |
| `refreshKey` teardown + 4-pool verify | D11 | n/a | ✓ |
| `useSmartPolling` delete **+ `PriceProvider` 60s-poll reconcile (sync debt)** + first smoke | D12 | n/a | ✓ |
| Test infra (vitest + RTL) | D13–15 | n/a | ✓ |
| Unified mutation error/toast UX | D16–17 | n/a | ✓ |
| Optimistic updates (earn + margin) | D18–19 | n/a | ✓ |
| **Mercury indexer integration** | **D20–22** | ✅ free dev tier | Includes new Aquarius/Soroswap LP events, not just original 12 |
| **Analytics-island rework** (audit item 14) | **D22** | ✅ free | NEW — 5 `setTimeout(30s)` polling pages + bespoke store → RQ/tick; retire `allMarginAccounts` unbounded read via Mercury/Hubble. Pulled into S1; rides Mercury |
| **Hubble BigQuery analytics** | **D23–24** | ✅ free (1TB/mo) | Queries hit `crypto-stellar.crypto_stellar.contract_events` for all 4 pools |
| **Stats snapshot-cache layer** (fast cold-load for ALL stats) + Analytics/Risk perf | D25 | ✅ free (own edge routes) | NEW — `/api/account/[addr]` + `/api/pools` edge snapshots fix slow Margin/Earn/Farm/Portfolio stats; pulled in from S2/S3 |
| Zustand dual-write cleanup | D26 | n/a | ✓ |
| Docs + `ARCHITECTURE.md` | D27 | n/a | ✓ |
| Bug bash + e2e (now covers Mercury+Hubble) | D28–29 | n/a | ✓ |
| Final integration → main | D30 | n/a | ✓ |

### STILL deferred post-v3.1

| Original sprint | Deliverable | Reason still deferred |
| --- | --- | --- |
| S2 | `ProtocolViewContract` (compressor) | Needs a Soroban dev. Not on team for v3.1. |
| S3 | Edge cache (`/api/snapshot`, `/api/account/[addr]`) | Caching after reactive layer is the right order, but pushing past 30 days. Sprint 2 candidate. |
| S6 | Production infra + 2× RPC HA + load test + mainnet config | Pre-mainnet concern. v3.1 is testnet. |
| Type safety pass | (was D25–26) | Cut from v3.1 to make room for Mercury+Hubble. Folded into ongoing reviewer discipline. |

### Scaling strategy (free → upgrade only if needed)

- **Mercury:** Start free dev tier. Prioritize `Trader_*` events for margin history (highest-value). If free entity cap hit, Aquarius/Soroswap LP event hooks stay on RPC until Pro upgrade ($79/mo).
- **Hubble:** BigQuery free tier (1TB/mo queries) — comfortably covers protocol event volume for the foreseeable future. SDF maintains the public `crypto-stellar` dataset.
- **No payment decision required for v3.1.** Mercury Pro / Edge cache / 2× RPC HA / mainnet config all become Sprint 2 conversations once v3.1 lands.

---

### Code state (audited 2026-05-19, post-merge)

Nothing from Sprint 1 has shipped yet. The starting line:

| Anti-pattern | Count | Locations |
| ------------ | ----- | --------- |
| `refetchInterval` on chain data | 11 | `use-earn.ts` (×2), `use-margin.ts` (×1), `use-farm.ts` (×5), `use-soroswap.ts` (×3) |
| Chain-data `setInterval` | 2 | `hooks/use-token-prices.ts:47`, `app/page.tsx:114` |
| `refreshKey` reads | 8 | `use-farm.ts` (×5), `use-soroswap.ts` (×3), `app/farm/[id]/page.tsx` (×4) |
| Imperative mutation wrappers | 4 hook + 8 inline | See mutation table below |
| `LedgerSubscriberProvider` | not built | — |

The 5 upstream commits pulled into `main` on 2026-05-19 (risk dashboard, HF/net-earning fix, one-click APY live, Blend liquidity HF bug, LP-token deposit tracking) introduce **no new files** requiring extra scope beyond what's already enumerated.

### Mutation strategy — full `useMutation` migration

Every mutation gets migrated to `@tanstack/react-query`'s `useMutation`. Each one wires `onSuccess: () => queryClient.invalidateQueries(...)` against the right key. The manual `refreshAllBalances()` / `refreshBorrowedBalances()` / `triggerRefresh()` calls get deleted — RQ cache becomes the single source of truth.

| Where | What exists today | Target |
| --- | --- | --- |
| `hooks/use-earn.ts:227` | `useSupplyLiquidity` — imperative, calls `refreshAllBalances()` | `useMutation`, drop manual refresh |
| `hooks/use-earn.ts:350` | `useWithdrawLiquidity` — same | Same |
| `hooks/use-wallet.ts:199` | `useDeposit` — wraps `ContractService.deposit` | `useMutation` |
| `hooks/use-wallet.ts:276` | `useWithdraw` — wraps `ContractService.withdraw` | `useMutation` |
| `components/margin/repay-loan-tab.tsx` | Inline mutation + `refreshBorrowedBalances` | Local `useMutation`, drop manual refresh |
| `components/margin/leverage-assets-tab.tsx`, `transfer-collateral.tsx`, `collateral-box.tsx`, `borrow-box.tsx` | Same inline pattern (4 files) | Same |
| `components/spot/spot-nonorderbook/SwapCard.tsx`, `components/lite-mode/position-detail.tsx` | Inline swap / one-click mutations | Same |
| `components/farm/add-liquidity.tsx:61`, `components/farm/remove-liquidity.tsx:30` | `triggerBlendRefresh()` post-tx | `useMutation` with `onSuccess: invalidateQueries({ queryKey: ['farm'] })` |

**4 hook-level + ~8 inline = ~12 mutation sites · ~10–15 caller refactors.**

---

## Strategy

**Phase 1 (Days 1–7) — Solo:** Sanujit owns the entire foundation. The work is independent and well-bounded: build `LedgerSubscriberProvider`, migrate all hook-level + inline mutations, rewire `token-prices` tick. No pairing required, no upstream blockers after Day 2 once the provider is merged.

**Phase 2 (Days 8–30) — Two-dev parallel:** Rohit joins. Both devs work in parallel tracks. The hook `refetchInterval` migration splits cleanly (earn+margin vs farm+soroswap), and from Day 13 onward the work fans out into independent optimization streams (test infra, optimistic updates, analytics perf, etc.) that don't share files.

**Net vs v2:** v2 budgeted 10 dev-days for 2 devs over 5 calendar days. v3.1 budgets ~7 solo dev-days (Phase 1) + ~46 dev-days for 2 devs over 23 calendar days (Phase 2) = ~53 dev-days total. Phase 2 split: test infra (~6), unified error UX (~4), optimistic updates (~4 — reduced), **Mercury indexer (~6) NEW**, **Hubble analytics (~4) NEW**, analytics+risk perf (~2 — reduced), dual-write consolidation (~2), docs (~2), bug bash + e2e (~4), buffer (~12). Type safety pass cut (folded into PR review discipline).

**Cost target:** $0/mo during the sprint. Mercury free dev tier + BigQuery free 1 TB/month. Mercury Pro ($79/mo) is the post-sprint upgrade path **only if** we exceed the free entity cap. No payment decisions during v3.1.

---

## Branching Strategy

```
main                                                  (mercury-stellar-backend — merge 7c25ac7 from new-contract-update)
  └─ feat/stellar-rewire                    (long-lived integration branch — cuts from main 2026-05-19)
       │
       │  ── Phase 1 (Sanujit, solo) ──
       ├─ s1/ledger-provider                          (D1–2)   ✅ merged (PR #4, #5) 2026-05-19
       ├─ s1/mutations-hook                           (D3)     ✅ merged (PR #6) 2026-05-20
       ├─ s1/mutations-hook-wallet                    (D4)     ✅ merged (PR #7) 2026-05-21
       ├─ s1/token-prices-tick                        (D5)     🔄 IN PROGRESS
       ├─ s1/mutations-inline                         (D6–7 — 8 inline component mutations)
       │
       │  ── Phase 2 (Sanujit + Rohit, parallel) ──
       ├─ s1/hooks-tick-earn-margin                   (D8–10  · Dev A)
       ├─ s1/hooks-tick-farm-soroswap                 (D8–10  · Dev B)
       ├─ s1/cleanup-refreshkey                       (D11)
       ├─ s1/cleanup-smartpolling                     (D12)
       ├─ s2/test-infra-services                      (D13–15 · Dev A)
       ├─ s2/test-infra-hooks                         (D13–15 · Dev B)
       ├─ s3/error-ux                                 (D16–17)
       ├─ s3/optimistic-earn                          (D18–19 · Dev A)
       ├─ s3/optimistic-margin                        (D18–19 · Dev B)
       ├─ s4/mercury-setup                            (D20    · joint — free tier signup + client + entities)
       ├─ s4/mercury-events-margin-farm               (D21    · Dev A)
       ├─ s4/mercury-events-soroswap-earn             (D21    · Dev B)
       ├─ s4/mercury-analytics-migration              (D22    · joint)
       ├─ s4/hubble-api                               (D23    · Dev A — BigQuery + 4 API routes)
       ├─ s4/hubble-ui                                (D23–24 · Dev B — /stats page UI)
       ├─ s4/perf-analytics-risk                      (D25    · joint — reduced from 3 days)
       ├─ s4/dual-write-cleanup                       (D26)
       ├─ s4/docs                                     (D27)
       └─ s4/release                                  (D28–30 — bug bash + final integration → squash to main)
```

**Rules:**

- **Trunk is `main`** of mercury-stellar-backend.
- **Integration branch** `feat/stellar-rewire` collects all 17 phase branches. Each phase branch PRs into the integration branch.
- **Old v2 branches** (`feat/sprint-1-rewire`, `feat/s1-*`) remain on origin as reference — do not delete.
- **Daily PRs** into the integration branch. Cross-review SLA: same-day before EOD (Phase 2).
- **Each branch must pass** `npm run lint && npm run build` before merge.
- **Day 30 EOD:** integration branch → `main` via squash merge.

---

## Phase 1 — Solo Foundation (Days 1–7, Sanujit)

### Day 1 — LedgerSubscriberProvider (scaffold)

- [ ] `git checkout main && git pull` → `git checkout -b s1/ledger-provider feat/stellar-rewire`
- [ ] Verify Soroban testnet RPC + Horizon SSE working with curl
- [x] Build `contexts/ledger-subscriber.tsx` (see Day 1 section in `IMPLEMENTATION_PLAN.md` for current v3-updated code). Subscribe via Horizon `streamLedgers` SSE; expose `useLedgerTick()` → `{ tick, latestLedger }` ✅ **shipped 2026-05-19 on branch `s1/ledger-provider`**
- [ ] Wrap `app/layout.tsx` with `<LedgerSubscriberProvider>` *inside* `<QueryProvider>` so it can call `queryClient.invalidateQueries`

### Day 2 — LedgerProvider verify + merge ✅ 2026-05-19

- [x] DevTools: `tick` increments every ~5 s, no console errors ✅ verified 2026-05-19 (`tick: 112`, `latestLedger: 2634844`)
- [x] SSE reconnect — relying on EventSource built-in auto-reconnect (documented in `contexts/ledger-subscriber.tsx`); verify via DevTools "Offline" toggle
- [x] Tab visibility — chose **keep stream running**; documented in `contexts/ledger-subscriber.tsx`
- [x] `npm run lint && npm run build` clean
- [x] Merge PR #4 + PR #5 (`s1/ledger-provider` → `feat/stellar-rewire`) ⚡ unblocks all later tick wiring

### Day 3 — Hook-level mutations (earn) ✅ 2026-05-20 (PR #6)

- [x] `git checkout -b s1/mutations-hook feat/stellar-rewire`
- [x] Convert `useSupplyLiquidity` (`hooks/use-earn.ts`) to `useMutation`. Wire `onSuccess: () => qc.invalidateQueries({ queryKey: ['earn'] })`. Delete inline `refreshAllBalances()`.
- [x] Convert `useWithdrawLiquidity` (`hooks/use-earn.ts`). Same pattern.
- [x] Delete the outdated comment ("Mutations — stay imperative")
- [x] Updated earn caller sites (`components/earn/*`)
- [x] **PR #6 → `feat/stellar-rewire` merged** (`80b8048`)

### Day 4 — Hook-level mutations (wallet) ✅ 2026-05-21 (PR #7)

- [x] `git checkout -b s1/mutations-hook-wallet feat/stellar-rewire`
- [x] Convert `useDeposit` (`hooks/use-wallet.ts`) to `useMutation`. Invalidate `['earn']` + `['margin']` as appropriate.
- [x] Convert `useWithdraw` (`hooks/use-wallet.ts`). Same pattern.
- [x] Caller refactors: `components/portfolio/deposit-modal.tsx`, `components/portfolio/withdraw-modal.tsx`
- [x] `npm run lint && npm run build` clean
- [x] **PR #7 → `feat/stellar-rewire` merged** (`b12e2fb`)

### Day 5 — token-prices tick + setInterval cleanup 🔄 IN PROGRESS (2026-05-21)

- [ ] `git checkout -b s1/token-prices-tick feat/stellar-rewire`
- [ ] Rewire `hooks/use-token-prices.ts:47`: drop 30 s `setInterval(refresh, REFRESH_INTERVAL_MS)`. Wrap `useTokenPrices` in `useQuery` with `queryKey: ['oracle','prices', sortedSymbols, tick]`
- [ ] Delete `app/page.tsx:114` `setInterval(refreshBorrowedBalances, 30000)`. Hook-level tick on `useMarginHistory` + `useUserPositions` (after Phase 2 D8–10) replaces it. Interim: keep a `useEffect` that invalidates `['margin']` on tick change.
- [ ] Verify Network tab: no 30 s pulse on Reflector price calls; refresh is now ledger-close (~5 s)
- [ ] **PR `s1/token-prices-tick` → integration branch**

### Day 6 — Inline mutations (margin)

- [ ] `git checkout -b s1/mutations-inline feat/stellar-rewire`
- [ ] Extract inline mutations to local `useMutation` in:
  - `components/margin/repay-loan-tab.tsx` — `onSuccess` invalidates `['margin']`, delete `refreshBorrowedBalances(...)` call
  - `components/margin/leverage-assets-tab.tsx` (4 sites: L537, L557, L773, L795)
  - `components/margin/transfer-collateral.tsx`
  - `components/margin/collateral-box.tsx`, `borrow-box.tsx`

### Day 7 — Inline mutations (swap/lite/farm) + Phase 1 review

- [ ] Extract inline mutations in:
  - `components/spot/spot-nonorderbook/SwapCard.tsx` — invalidate `['margin']` + `['soroswap']`
  - `components/lite-mode/position-detail.tsx`
  - `components/farm/add-liquidity.tsx:61` — invalidate `['farm']`, delete `triggerBlendRefresh()`
  - `components/farm/remove-liquidity.tsx:30` — same
- [ ] `npm run lint && npm run build` clean
- [ ] **PR `s1/mutations-inline` → integration branch**
- [ ] **Phase 1 review (EOD):** all 12 mutation sites on `useMutation`. Smoke test supply/withdraw/repay on testnet against one pool.

**Phase 1 done when:** LedgerProvider live · 12 mutations on `useMutation` · `token-prices` on tick · `app/page.tsx:114` setInterval deleted.

---

## Phase 2 — Two-Dev Parallel (Days 8–30)

### Days 8–10 — Hook tick migration

| Dev A (earn + margin) | Dev B (farm + soroswap) |
| --- | --- |
| `hooks/use-earn.ts` — drop `refetchInterval: 30_000` on `usePoolData`, `refetchInterval: 10_000` on `useEarnTransactions`. Add `tick` to both queryKeys. | `hooks/use-soroswap.ts` — drop 60 s `refetchInterval` on `useAllSoroswapPoolStats` + `useSoroswapPoolStats`; drop 10 s on `useSoroswapEvents`. Add `tick` to queryKeys. Delete `refreshKey` reads (L78, L101, L125). |
| `hooks/use-margin.ts` — drop `refetchInterval: 10_000` on `useMarginHistory`. Add `tick` to queryKey. | `hooks/use-farm.ts` — drop 60 s on `useBlendPoolStats`, `useAllAquariusPoolStats`, `useAquariusPoolStats`. Drop 10 s on `useBlendEvents`, `useAquariusEvents`. Delete `refreshKey` reads in all 5 places. |
| Verify each hook invalidates on ledger tick via RQ DevTools. Confirm 4-pool fetch (XLM/USDC/AQUARIUS_USDC/SOROSWAP_USDC) still works. | Confirm `useAllAquariusLpPositions` and `useSoroswapTokenBalance` also get tick treatment. |
| **PR `s1/hooks-tick-earn-margin`** | **PR `s1/hooks-tick-farm-soroswap`** |

### Day 11 — `refreshKey` teardown + farm-component read cleanup + 4-pool verify

- Dev A: Delete `refreshKey` + `triggerRefresh` from `store/blend-store.ts` (file is 17 lines — likely empty or gets deleted). Drop the `refreshKey` reads in `app/farm/[id]/page.tsx`. Confirm no remaining `triggerBlendRefresh()` callers.
- Dev A (audit item 9): in `components/farm/add-liquidity.tsx` + `remove-liquidity.tsx`, drop the duplicate imperative pool-stat/balance `useEffect`s that re-fetch what `useAllAquariusPoolStats`/`useSoroswapPoolStats`/`use*LpPosition` already cache, and remove the manual `refreshDexMarginBalances`/`refreshBorrowedBalances`/setState post-tx refreshes — mutations should pure-`invalidateQueries`. (We're already editing these files for `triggerBlendRefresh`.)
- Dev B: 4-pool end-to-end verify on testnet — supply/withdraw/borrow/repay each of XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC. Confirm balance updates ≤5 s without manual refresh.
- Final grep: `grep -rn "refreshKey\|triggerRefresh" .` returns nothing.
- **Joint PR `s1/cleanup-refreshkey`**.

### Day 12 — Kill remaining polling (`useSmartPolling` + `PriceProvider`) + first integration smoke

- Dev A: Delete `lib/hooks/useSmartPolling.ts`. Remove import from `app/margin/page.tsx`. Update JSDoc in `contexts/query-provider.tsx:11`. **Also fix the `contexts/ledger-subscriber.tsx` JSDoc** (audit nit) — it still tells devs to put `tick` in the queryKey, the exact anti-pattern CLAUDE.md §1 bans; trivial fix that prevents copy-paste regressions. Confirm which margin page ships (`app/page.tsx` is tick-driven; `app/margin/page.tsx` is a second, still-polling copy — retire the dead one).
- Dev A: **Reconcile the price system** (debt from the 2026-05-27 sync). `contexts/price-context.tsx` polls XLM price on a 60s `setInterval` — the chain-data polling anti-pattern this sprint removes. Collapse it onto the ledger tick (or retire `PriceProvider` in favour of `hooks/use-token-prices.ts`), then drop the dual `useTokenPrices` API (7 files currently import both, aliased `useTokenPricesFromHook`) so there is one source of truth. Target: `grep -rn "setInterval" contexts/` returns nothing.
- Dev B: First full integration smoke pass on testnet (supply, borrow, swap, add liquidity, remove liquidity across all 4 pools). Document any bugs surfaced.
- **PR `s1/cleanup-smartpolling`** (covers both polling removals).

### Days 13–15 — Test infrastructure

| Dev A (services) | Dev B (hooks) |
| --- | --- |
| Install vitest + happy-dom. Configure for ESM + TS. Add `npm run test` script. | Install React Testing Library. Configure with vitest. |
| Unit tests: `ContractService.deposit`/`withdraw`/`getPoolStats` happy + failure path. Mock Soroban client at the `rpcServer` boundary. | Hook tests: `useLedgerTick` (mocks Horizon SSE), `useSupplyLiquidity` (`renderHook` + `act` for mutation lifecycle, RQ provider wrapper). |
| Unit tests: `MarginAccountService.getMarginTransactionHistory`, repay/borrow service-layer paths. | Hook tests: `usePoolData` tick-driven invalidation, `useEarnTransactions`. |
| Aim: ~30 service-layer tests across 4 services. | Aim: ~15 hook tests. |
| **PR `s2/test-infra-services`** | **PR `s2/test-infra-hooks`** |

### Days 16–17 — Unified mutation error/toast UX + last mutation holdouts

Both devs: replace ad-hoc `useState({type:'',text:''})` patterns in 12 mutation callers with a single hook (e.g., `useMutationToast(mutation, { success, error })`). One toast lib (sonner or react-hot-toast — pick first). Error normalization centralised in `lib/errors/normalize.ts` (replaces ad-hoc `normalizeSupplyError`, `normalizeWithdrawError` in `use-earn.ts`).

- Audit item 11: convert the `components/margin/leverage-assets-tab.tsx` **WB deposit+borrow flow** from its hand-rolled async handler to `useMutation` (only the MB borrow-only path is migrated today) and remove its 4 manual `refreshBorrowedBalances` sites.
- Audit item 12: surface the silently-swallowed read errors in `store/margin-account-info-store.ts` (farm-merge / SAC-reconcile / borrow-rate `console.warn`-only) through the new error path, so a failed read doesn't show a wrong HF/collateral with no signal.

**Joint PR `s3/error-ux`**.

### Days 18–19 — Optimistic updates

| Dev A (earn supply/withdraw) | Dev B (margin borrow/repay) |
| --- | --- |
| `onMutate`: snapshot current `['earn', 'positions', ...]` cache, write predicted post-deposit balance. | `onMutate`: snapshot `['margin', ...]`, write predicted post-borrow debt + HF. |
| `onError`: rollback to snapshot. `onSettled`: invalidate to reconcile. | Same pattern. |
| Visual: supply button shows "Confirming…" but balance updates immediately, snaps back if tx fails. | Visual: borrow shows new HF immediately; rolls back on revert. |
| **PR `s3/optimistic-earn`** | **PR `s3/optimistic-margin`** |

### Days 20–22 — Mercury indexer integration (NEW in v3.1)

> **Prereq:** Sign up a Mercury **free dev tier** account at [mercurydata.app](https://mercurydata.app) before D20 starts. No payment needed.

**D20 — Mercury setup + entity config**

| Dev A | Dev B |
| --- | --- |
| Sign up Mercury free tier, add testnet contracts (`AccountManager`, `LendingPool{XLM,USDC,AQUARIUS_USDC,SOROSWAP_USDC}`). | Audit current event hooks to map them to Mercury entities: `useMarginHistory` (use-margin.ts), `useBlendEvents` / `useAquariusEvents` (use-farm.ts), `useSoroswapEvents` (use-soroswap.ts), `useEarnTransactions` (use-earn.ts). |
| Configure free-tier entities — **prioritize** `Trader_Borrow`, `Trader_Repay_Event`, `Trader_Liquidate_Event`, `Trader_SettleAccount_Event`, `Smart_account_creation`. If free entity cap allows: add `deposit_event`, `withdraw_event` per pool, Aquarius LP `add/remove_liquidity`, Soroswap `swap`/`add/remove_liquidity`. | Build `lib/mercury-client.ts` (GraphQL client using `graphql-request`). Add `NEXT_PUBLIC_MERCURY_URL` + `NEXT_PUBLIC_MERCURY_KEY` to env. |
| Write GraphQL queries: `HISTORY_QUERY` (borrows/repays/liquidations), `EVENTS_QUERY` (pool-level), `LEADERBOARD_QUERY` (top borrowers). | Test client end-to-end against testnet account that has some real history. |

**D21 — Migrate event hooks**

| Dev A (margin + farm) | Dev B (soroswap + earn) |
| --- | --- |
| `useMarginHistory` (use-margin.ts:7) — replace localStorage merge with Mercury query. Drop ledger-tick refetch (Mercury push-driven). | `useSoroswapEvents` (use-soroswap.ts:97) — replace RPC pagination with Mercury query. |
| `useBlendEvents` + `useAquariusEvents` (use-farm.ts) — same. If Aquarius events not in free-tier entity set, keep on RPC + add TODO. | `useEarnTransactions` (use-earn.ts:514) — same. If event not indexed, keep on RPC. |
| **PR `s4/mercury-events-margin-farm`** | **PR `s4/mercury-events-soroswap-earn`** |

**D22 — Reclaim the analytics island (audit item 14) — full rework, pulled into S1**

The analytics surface is a pre-rewire island: bespoke imperative store, 5 pages on 30s
`setTimeout` polling, an unbounded all-accounts × per-token RPC fan-out. This day brings
it onto Mercury/Hubble/tick. ~3–4 dev-days of work absorbed across D22 + the Mercury/
Hubble block + the D28–29 buffer; see the "Drop-first buffer" note below to protect D30.

- Both devs pair: audit `app/analytics/liquidations/page.tsx`, `components/analytics/positions/PositionsMonitor.tsx`, `components/analytics/risk-explorer/BadDebtMonitorSummary.tsx` — these replay events client-side from RPC. Switch to Mercury queries where entities are indexed; Hubble (D23–24) backs the protocol-wide aggregates.
- **Retire `lib/analytics/stellar/allMarginAccounts.ts` unbounded fan-out** (reads the whole accounts Vec + per-account + per-token RPC) — back the all-accounts roster with Mercury/Hubble instead of live N×token RPC. (Further mainnet-scale pagination/edge-cache of the roster stays S2.)
- **Convert the 5 `setTimeout(pull, 30_000)` polling pages** (`oracles`, `alerts`, `whales`, `liquidations`, `risk-explorer`) to ledger-tick / Mercury-backed reads. These evaded the earlier `setInterval` greps.
- **Migrate the bespoke `lib/analytics/onchain/store.ts`** imperative `useEffect`-load to the RQ + ledger-tick pattern (CLAUDE.md §1), so analytics reads cache, dedupe, and refresh on tick like the rest of the app.
- Surface the swallowed analytics read errors (`fetchTokenPrices().catch(() => undefined)`, `simulateView` null-swallow) instead of silently showing wrong totals / dropping accounts.
- Verify: `grep -rn "localStorage.*history" .` empty; `grep -rn "setTimeout(.*30_000\|setTimeout(.*30000" app/analytics/` empty (only allowlisted UI timers remain).
- **Joint PR `s4/mercury-analytics-migration`**.

> **Risk note:** If Mercury free tier caps entities below what we need, the lowest-priority hooks (Aquarius/Soroswap LP events) stay on RPC. The high-value migration (margin history + liquidations) is non-negotiable.

### Days 23–24 — Hubble analytics (NEW in v3.1)

> **Prereq:** Free Google Cloud account + enable BigQuery API (free). **"Hubble" is NOT a separate paid service** — it's SDF's name for their public BigQuery dataset (`crypto-stellar.crypto_stellar.contract_events`). 1 TB/month free query quota covers our event volume comfortably.

**D23 — BigQuery setup + API routes**

| Dev A (backend) | Dev B (UI scaffolding) |
| --- | --- |
| Create GCP project, enable BigQuery, create service account with `BigQuery Job User` + `BigQuery Data Viewer` roles. Save JSON to Vercel env: `GOOGLE_CREDS_JSON`. | Scaffold `/stats` page route (`app/stats/page.tsx`). Stub chart containers with placeholder data. |
| Write 4 SQL queries adapted for **current 4-pool architecture** (XLM/USDC/AQUARIUS_USDC/SOROSWAP_USDC, NOT old USDC/XLM/EURC): daily TVL, top borrowers all-time, daily borrow volume, recent 50 liquidations. | Pick chart lib — `recharts` already in package.json (per merge `d636247`). Reuse from analytics pages. |
| Build 4 API routes: `/api/analytics/tvl`, `/api/analytics/top-borrowers`, `/api/analytics/volume`, `/api/analytics/liquidations`. `Cache-Control: s-maxage=300, stale-while-revalidate=900`. Edge runtime. | Confirm `recharts` styles match analytics pages (consistent design). |
| **PR `s4/hubble-api`** | (same branch as Dev A or scaffold-only on integration) |

**D24 — Wire `/stats` UI**

- Both devs pair: connect `/stats` page to the 4 API routes. Render TVL chart (90-day line), top-100 borrowers list, daily volume bars, liquidation feed.
- Verify: open `/stats` on testnet, all 4 panels populate with real data within 2 seconds (BigQuery query latency).
- Verify: BigQuery month-to-date cost in GCP console reads $0.
- **Joint PR `s4/hubble-ui`**.

### Day 25 — Stats snapshot-cache layer (fast cold-load for ALL stats) + analytics perf

The slow cold-load is **every** stat panel that reads live chain state — Margin
(HF / collateral / borrowed), Earn (vault stats + user positions), Farm (pool stats +
LP positions), Portfolio summary. The fix is a **server-side snapshot-cache layer**:
read the chain once on the edge, cache it, serve clients an instant snapshot, and let
the ledger tick + the user's own mutations invalidate. Reuses the edge-API-route +
`Cache-Control` + RQ-wiring patterns established by Hubble (D23). Two parallel tracks.

**Dev A — `s4/account-snapshot-cache` (per-user stats):**
- Edge route `app/api/account/[addr]/route.ts` → one cached payload with the user's
  live state across pages: margin `{ avgHealthFactor, totalCollateralValue, netAvailableCollateral, totalBorrowedValue }`,
  earn positions, farm LP positions, portfolio totals. Edge runtime.
  `Cache-Control: s-maxage=15, stale-while-revalidate=60`.
- **Parallelize the read source (audit item 1):** the server read must collapse
  `refreshBorrowedBalances`' 3 sequential awaits (farm-merge → SAC-reconcile →
  borrow-rate) into a single parallel batch, so even a cache *miss* isn't a serial
  waterfall.
- Hook `hooks/use-account-snapshot.ts` on the **ledger-tick stable-queryKey +
  invalidate-on-tick** pattern (CLAUDE.md §1). First paint serves the cached snapshot
  (instant on warm cache); ledger tick + the user's borrow/repay/transfer/supply/
  withdraw mutations invalidate it.
- Wire the Margin stats bar, `/portfolio` summary, and Earn/Farm user-position panels
  to the snapshot. The imperative chain-read paths become the cache-miss fallback only.
- Audit item 2: collapse `useUserPositions`' 3 serial RPC waves into one + reuse the
  pool-stats cache instead of re-fetching what `usePoolData` already has.

**Dev B — `s4/pool-snapshot-cache` (shared pool stats) + analytics perf:**
- Edge route `app/api/pools/route.ts` → pool-level stats shared across all users
  (TVL, APY, reserves, utilisation for all 4 pools + Aquarius/Soroswap). Longer TTL
  (`s-maxage=30, stale-while-revalidate=120`) since pool stats move slower than a
  single account. Wire Earn vault-stat cards + Farm pool-stat cards to read it.
- Then the original D25 perf: memoize `lib/analytics/onchain/derivations.ts`, profile
  `PositionsMonitor.tsx`, fix `BadDebtMonitorSummary.tsx` per-render derivation.
  `lib/analytics/oracle-agents/store.ts` simulation `setInterval` stays (allowlist).
- Audit item 5: delete the dead per-tick `useMemo` in `components/margin/positions-table.tsx`
  that recomputes interest accrual every ~5s and then discards it (UI hardcodes `$0`).

**Done when:** every stats panel (Margin / Earn / Farm / Portfolio) renders in
**< 1 s on a warm edge cache** — the absolute first cache-miss per account/pool is
still bounded by one server-side chain read; all panels update within ~5 s post-tx
with no manual refresh. (If the layer needs more than one day, it shares the
D28–29 bug-bash buffer — it's a hard requirement, the analytics memoization is the
drop-first.)

### Day 26 — Zustand dual-write consolidation + repay-tab cleanup

- Audit `useEarnPoolStore.getState().set({...})` calls in `use-earn.ts:48,84`. Decide: remove (and migrate readers to RQ) or keep (and document why dual-write is intentional).
- Same audit for `store/margin-account-info-store.ts` — `refreshBorrowedBalances` writes at L148, 160, 195.
- Recommend remove unless a non-RQ legacy reader is found.
- Audit item 10: `components/margin/repay-loan-tab.tsx` — move the imperative debt/wallet-balance `useState` reads onto the account snapshot / RQ, and drop the 3 manual post-tx refreshes (`invalidateQueries(['margin'])` already covers it).
- **Joint PR `s4/dual-write-cleanup`**.

> **Type safety pass cut from v3.1.** Was D25–26 in v3 (4 dev-days). Folded into reviewer discipline (catch `any` in PR review) + ongoing during all other Phase 2 work. Dedicated pass deferred to a future sprint.

> **Drop-first buffer (protect D30).** The analytics rework (D22) + stats snapshot
> layer (D25) are the heavy adds. If the back half runs hot, drop in this order:
> (1) `ARCHITECTURE.md` (D27) → post-sprint; (2) analytics derivation memoization
> (D25) → defer (correctness is already fine); (3) Mercury low-priority LP-event
> entities → stay on RPC. **Never drop:** the snapshot cache, Mercury `Trader_*` +
> margin history, Hubble `/stats`, analytics off 30s-polling, 4-pool e2e, merge to main.
> Full findings + per-item day mapping: [CODEBASE_AUDIT.md](CODEBASE_AUDIT.md).

### Day 27 — Documentation

- Update `SPRINT_1_GUIDE.md` (this doc) — mark each Phase 2 step done.
- Update `IMPLEMENTATION_PLAN.md` "What's done in S1" section. Mark Day 1, 2, 3 stubs as ✅ shipped where applicable; document the Mercury + Hubble integration as Sprint 4 + Sprint 5 of the original plan, now landed.
- Write new `ARCHITECTURE.md` summarizing post-sprint state: ledger-tick model, mutation pattern, store/RQ split, test layout, Mercury entity map, Hubble query map.
- Update `contexts/query-provider.tsx` JSDoc.
- **Joint PR `s4/docs`**.

### Days 28–29 — Bug bash + full testnet e2e

Both devs pair. Run every flow:
- **Earn** × 4 assets (XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC) — supply/withdraw, balance updates ≤5 s
- **Margin** × 4 assets — deposit/borrow/repay/transfer/withdraw, HF updates ≤5 s
- **Farm** × Aquarius + Soroswap — add/remove liquidity, LP balance updates ≤5 s
- **Lite + One-click** — entry flow, position detail reactive
- **Risk Dashboard regression** — `/analytics` renders, oracle sim tick still firing (sim NOT chain — allowlist)
- **NEW v3.1: Mercury-backed flows** — margin history populates from Mercury, liquidations feed populates, leaderboard renders
- **NEW v3.1: `/stats` page** — TVL chart, top borrowers, volume, liquidations all populate within 2 s

Each scenario verifies functional success AND reactive UI update ≤5 s.

Fix any bugs found in `s4/release`.

### Day 30 — Final integration + handoff

- `npm run lint && npm run build && npm run test` all green
- Final grep audit (from v2 Day 5):
  ```bash
  grep -rn "refetchInterval" hooks/ app/        # empty
  grep -rn "refreshKey\|triggerRefresh" .       # empty
  grep -rni "coingecko" .                       # empty
  grep -rn "refreshAllBalances\|refreshBorrowedBalances" .  # empty
  ```
- `setInterval` allowlist (NOT chain data — leave alone):
  - `components/faucet/faucet-popup.tsx` — countdown timer
  - `components/analytics/layout/Header.tsx` — clock
  - `components/ui/carousel.tsx` — slide rotation
  - `components/ui/bridging-dialogue.tsx` — animation
  - `lib/analytics/oracle-agents/store.ts` — simulation agent tick
- Squash-merge `feat/stellar-rewire` → `main`
- Write CHANGELOG entry summarizing the 30-day sprint
- Tag release `v0.s1.0`

---

## Migration Patterns

**Mutation pattern (Phase 1):**

```typescript
// Before (imperative wrapper)
export const useSupplyLiquidity = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });
  const supply = useCallback(async (amount, assetType) => {
    setIsLoading(true);
    const result = await ContractService.deposit(address, amount, assetType);
    await refreshAllBalances();   // manual refresh
    setIsLoading(false);
    return result;
  }, [address]);
  return { supply, isLoading, message };
};

// After (useMutation)
export const useSupplyLiquidity = () => {
  const qc = useQueryClient();
  const address = useUserStore(s => s.address);
  return useMutation({
    mutationFn: ({ amount, assetType }: { amount: number; assetType: AssetType }) =>
      ContractService.deposit(address, amount, assetType),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['earn'] }),
  });
};
// Caller:
//   const supply = useSupplyLiquidity();
//   await supply.mutateAsync({ amount, assetType });
//   if (supply.isSuccess) toast.success(...);
//   if (supply.error) toast.error(supply.error.message);
```

**Hook tick pattern (Phase 2 Days 8–10):**

```typescript
// Before
useQuery({
  queryKey: ['earn', 'pools'],
  queryFn: fetchPools,
  refetchInterval: 30_000,
  staleTime: 15_000,
});

// After
const { tick } = useLedgerTick();
useQuery({
  queryKey: ['earn', 'pools', tick],
  queryFn: fetchPools,
  staleTime: 4_000,
});
```

**Optimistic mutation pattern (Phase 2 Days 18–20):**

```typescript
useMutation({
  mutationFn: ({ amount }) => ContractService.deposit(address, amount, assetType),
  onMutate: async ({ amount }) => {
    await qc.cancelQueries({ queryKey: ['earn', 'positions'] });
    const prev = qc.getQueryData(['earn', 'positions']);
    qc.setQueryData(['earn', 'positions'], (old) => predictBalanceAfterDeposit(old, amount));
    return { prev };
  },
  onError: (_err, _vars, ctx) => qc.setQueryData(['earn', 'positions'], ctx.prev),
  onSettled: () => qc.invalidateQueries({ queryKey: ['earn'] }),
});
```

---

## Daily Operating Rhythm

**Phase 1 (solo):** EOD update in #stellar-development with PR opened/merged status. No daily standup needed.

**Phase 2 (2 devs):**

- **9:00 AM** — 15 min standup (Slack huddle in #stellar-development)
  - What I shipped yesterday
  - What I'm doing today
  - Any blockers
- **EOD** — async update: PRs opened/merged, what's left
- **PR review SLA:** same-day before EOD
- **Pair sessions:** Day 11 (4-pool verify), Day 22 (Mercury analytics migration), Day 24 (Hubble `/stats` UI wiring), Day 26 (dual-write consolidation), Days 28–29 (bug bash + e2e)

---

## Sprint Done When

- [ ] `LedgerSubscriberProvider` wraps app inside `QueryProvider`
- [ ] Zero `refetchInterval` in `hooks/` and `app/`
- [ ] Zero data-polling `setInterval` outside the allowlist
- [ ] Zero `refreshKey` / `triggerRefresh` references
- [ ] All 12 hook-level + inline component mutations migrated to `useMutation`, each with `onSuccess: invalidateQueries(...)`. No manual `refreshAllBalances` / `refreshBorrowedBalances` / `triggerRefresh` remain
- [ ] All hooks invalidate via ledger tick (queryKey includes `tick`)
- [ ] All 4 pools (XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC) verified end-to-end on testnet
- [ ] Risk Dashboard + Lite mode pass non-regression smoke test
- [ ] **NEW v3:** vitest + RTL set up, ≥45 tests passing (~30 service + ~15 hook)
- [ ] **NEW v3:** Optimistic updates live on earn + margin mutations
- [ ] **NEW v3:** Unified error/toast UX across all mutations
- [ ] **NEW v3:** Analytics + Risk Dashboard re-render audit clean
- [ ] **NEW v3:** Zustand dual-write decision documented (kept or removed)
- [ ] **NEW v3:** `ARCHITECTURE.md` written
- [ ] **NEW v3.1:** Mercury indexer integration live — `Trader_*` events indexed; margin history / liquidations feed read from Mercury, not RPC; localStorage history merge deleted
- [ ] **NEW v3.1:** `/stats` page live on BigQuery (Hubble) — TVL chart, top borrowers, daily volume, liquidation feed
- [ ] **NEW v3.1:** All third-party services on free tiers — Mercury free dev tier, BigQuery 1 TB/month free. Monthly cost: $0
- [ ] App works end-to-end on testnet

---

## Risk Buffer

- Days 28–29 have ~12 hrs total buffer for bugs found in the bug bash
- **Drop-firsts** if behind schedule:
  - Day 27 docs (`ARCHITECTURE.md`) → defer to post-sprint
  - Day 26 dual-write consolidation → keep dual-write, document and defer
  - Day 12 `useSmartPolling` delete → keep + document, defer delete
  - Day 25 analytics/risk perf → defer to post-sprint
  - Mercury low-priority entities (Aquarius/Soroswap LP events) → keep those event hooks on RPC, only migrate `Trader_*` events
- **Hard requirements** (cannot defer):
  - LedgerSubscriberProvider wired (D2)
  - 4 hook-level mutations on `useMutation` (D4)
  - All ledger-tick invalidations live (D10)
  - `refreshKey` machinery deleted (D11)
  - All 4 pools verified e2e on testnet (D29)

---

## Reference

- **Full implementation plan:** [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- **Architecture research:** [BACKEND_RESEARCH.md](BACKEND_RESEARCH.md)
- **Protocol-tailored plan:** [PROTOCOL_BACKEND_PLAN.md](PROTOCOL_BACKEND_PLAN.md)
- **Combination options:** [BACKEND_OPTIONS.md](BACKEND_OPTIONS.md)
- **Slack channel:** #stellar-development
- **Architecture diagram (IPFS):** https://ipfs.ninja/ipfs/QmdHcwpzeBw3MGhitodadxdPjsmpdcKDpZ5AZAmAt2R9kU

---

*Updated 2026-05-19 as v3.1. v2 (2026-05-14) was a 5-day plan for 2 devs in parallel. v3 (2026-05-19 AM) expanded to 30 days because Dev A (Rohit) is unavailable for the first 7 days. **v3.1 (2026-05-19 PM)** additionally promotes Mercury indexer + Hubble BigQuery analytics from "deferred" to "in Phase 2" by running both on **free tiers** ($0/mo). The 30-day budget now ships: ledger-tick foundation + full `useMutation` migration + test infra + optimistic updates + error UX + Mercury event indexing + Hubble historical analytics + analytics perf + dual-write cleanup + docs. Type safety pass cut (folded into PR review discipline). **Mutation strategy is unchanged from v1/v2: full `useMutation` migration for all hook-level + inline mutations.***
