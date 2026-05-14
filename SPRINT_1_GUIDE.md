# Sprint 1 Plan — Frontend Rewire (2-Dev Split)

> **Sprint 1 of 6 — Vanna Backend Implementation**
> **Duration:** 5 days · **Team:** 2 frontend devs in parallel
> **Goal:** Zero `setInterval` for chain data. Zero `refetchInterval`. Ledger-tick drives every read. Every mutation invalidates instead of imperatively refetching.
> **Companion doc:** [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (full code stubs + 6-sprint roadmap)
> **Branch under test:** `new-contract-update` (frontend) — multi-pool contracts live (XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC)
> **Notion source of truth:** https://www.notion.so/Sprint-1-Plan-Frontend-Rewire-2-Dev-Split-36042874c59b80e7a81fdec4d85eb0d7

---

## What Changed Since v1 of This Doc

Sprint 1 v1 was written before `new-contract-update` landed. A re-audit shows some original tasks are already done, and new ones are in scope.

### Already shipped on `new-contract-update` — drop from Sprint 1

- CoinGecko deleted — `grep -ri coingecko .` returns nothing.
- `contexts/price-context.tsx` deleted.
- `lib/prices.ts` deleted.
- `lib/oracle-price.ts` (Reflector wrapper) is live. `hooks/use-token-prices.ts` exposes `useTokenPrice` / `useTokenPrices` on top of it. The "delete + replace all `useTokenPrice("XLM")` imports" task is done.

### Still pending — Sprint 1 scope holds

- `LedgerSubscriberProvider` — not built.
- `setInterval` at `app/page.tsx:115` — still polls `refreshBorrowedBalances` every 30 s.
- `setInterval` at `hooks/use-token-prices.ts:47` — Reflector cache refresh every 30 s.
- `refetchInterval` still present in `use-earn.ts`, `use-margin.ts`, `use-farm.ts`, `use-soroswap.ts` (8 occurrences total).
- `refreshKey` / `triggerRefresh` machinery in `store/blend-store.ts` + 5 consumers.
- `lib/hooks/useSmartPolling.ts` still imported by `app/margin/page.tsx` and referenced in `contexts/query-provider.tsx` JSDoc.

### New scope added since v1 was written

| Area | Detail |
| ---- | ------ |
| Multi-pool ASSET_TYPES | `AQUARIUS_USDC` and `SOROSWAP_USDC` added alongside `XLM`/`USDC`. Every read path that lists pools must include all 4. `usePoolData` already does — verify the rest. |
| `useMarginHistory` | New hook in `hooks/use-margin.ts:7` — 10 s `refetchInterval`. Needs ledger tick. |
| `useAllAquariusPoolStats` / `useAllSoroswapPoolStats` | New multi-pool aggregators — 60 s `refetchInterval`. Needs tick. |
| Risk Dashboard & Analytics pages | New `lib/analytics/`, `lib/risk/`, `components/analytics/`. Uses `setInterval` for **simulation agent tick** (`lib/analytics/oracle-agents/store.ts`). **Scope out:** this is simulation, not chain data. Document in audit allowlist. |
| Lite Mode | New `components/lite-mode/`, `lib/one-click-strategy.ts`, `lib/hooks/useLiteModeGuard.ts`. Smoke-test path on Day 5. |
| `MarginAccountService.getMarginTransactionHistory` | New on-chain history reader — already in a query, just needs tick. |

### Architectural revision — mutation strategy

Original v1 said: *convert every mutation to `useMutation`*. Current code has a deliberate note at `hooks/use-earn.ts:223-225` explaining why imperative wrappers are kept:

> *"Mutations stay imperative. react-query's `useMutation` would be a clean fit here, but the message/loading UX is already wired through setState and the callers expect the existing return shape."*

**Revised plan:** keep the imperative `useSupplyLiquidity` / `useWithdrawLiquidity` / `useDeposit` / `useWithdraw` wrappers. Instead of full `useMutation` migration, **inject `queryClient.invalidateQueries(...)` on success and delete the manual `refreshAllBalances()` / `refreshBorrowedBalances()` / `triggerRefresh()` calls.** Same end-state (RQ cache is the source of truth, manual refresh disappears), far less churn at callsites. Inline component-level mutations (`repay-loan-tab.tsx`, `transfer-collateral.tsx`, etc.) get the same invalidate-on-success treatment.

---

## Strategy

Sprint 1 me 5 days of work hai for 1 dev. 2 devs ke saath parallel tracks chala ke same 5 days me khatam karenge with **safety buffer** + better integration testing.

**Critical dependency:** Day 1 ko `LedgerSubscriberProvider` build hona MUST hai — baki saara kaam `useLedgerTick` hook par depend karta hai. Isiliye Dev A Day 1 par usi pe focused hai, Dev B parallel me invalidation-on-success rewiring shuru karta hai (jo independent hai — `queryClient.invalidateQueries` already available).

**Net delta vs v1:** ~1.5 dev-days of Sprint 1 scope is already done (CoinGecko removal + price-context delete). That budget is being re-spent on multi-pool verification, new analytics regression checks, and the lite-mode smoke path on Day 5 — so calendar is unchanged but coverage is wider.

---

## Branching Strategy

```
new-contract-update                           (current trunk for Sprint 1)
  └─ feat/sprint-1-rewire                     (integration branch)
       ├─ feat/s1-ledger-provider             (Dev A — Day 1)
       ├─ feat/s1-token-prices-tick           (Dev A — Day 2)
       ├─ feat/s1-hooks-earn-margin           (Dev A — Day 3)
       ├─ feat/s1-mutation-invalidate         (Dev B — Day 1–2)
       ├─ feat/s1-hooks-farm-soroswap         (Dev B — Day 3)
       └─ feat/s1-cleanup                     (split — Day 4)
```

- **Trunk for this sprint is `new-contract-update`, not `main`.** All branches off it. Day 5 EOD: integration branch → `new-contract-update` (squash merge). `main` merge happens later via the standard contract-update PR.
- Daily PRs into the integration branch.
- Each branch must pass `npm run lint && npm run build` before merge.

---

## Day-by-Day Split

### Day 1 — Foundation + Parallel Invalidation Start

**Morning (pair, ~2 hrs):**

- [ ] Both devs: pull contract addresses for the 4 pools (XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC); set up `Stellar_backend/.env.local` per Sprint 0 prereqs
- [ ] Both devs: verify Soroban testnet RPC + Horizon SSE working with curl
- [ ] Both devs: `git checkout new-contract-update && git pull && git checkout -b feat/sprint-1-rewire`

**Afternoon (split):**

| Dev A (foundation track) | Dev B (mutation-invalidate track) |
| --- | --- |
| Build `contexts/ledger-subscriber.tsx` (full code from `IMPLEMENTATION_PLAN.md` L140–225). Subscribe via Horizon `streamLedgers` SSE; expose `useLedgerTick()` → `{ tick, lastLedgerSeq }` | Audit every mutation site — both hook-level *and* inline component-level. Produce a checklist: `grep -rn "ContractService\." hooks/ components/ app/` |
| Wrap `app/layout.tsx` with `<LedgerSubscriberProvider>` *inside* `<QueryProvider>` so it can call `queryClient.invalidateQueries` | Add `queryClient.invalidateQueries({ queryKey: ['earn'] })` to `useSupplyLiquidity` on success; delete the inline `refreshAllBalances()` call |
| Verify DevTools: `tick` increments every ~5 s, no console errors, RQ DevTools shows invalidations firing | Same treatment for `useWithdrawLiquidity` (hooks/use-earn.ts) and `useDeposit` / `useWithdraw` (hooks/use-wallet.ts) |
| **PR `feat/s1-ledger-provider` → review → merge** ⚡ blocker for Day 2+ | Open `feat/s1-mutation-invalidate` PR (work continues Day 2) |

**EOD Checkpoint:** LedgerProvider merged into integration. Dev B can now use `useLedgerTick` from Day 2.

---

### Day 2 — Branch Out

| Dev A (token-prices + page-level setInterval) | Dev B (inline component-level mutations) |
| --- | --- |
| Rewire `hooks/use-token-prices.ts:47`: drop the 30 s `setInterval(refresh, REFRESH_INTERVAL_MS)`. Wrap `useTokenPrices` in `useQuery` with `queryKey: ['oracle','prices', sortedSymbols, tick]` | Migrate inline mutation in `components/margin/repay-loan-tab.tsx` — replace `refreshBorrowedBalances(...)` callsites with `queryClient.invalidateQueries({ queryKey: ['margin'] })` |
| Delete `app/page.tsx:115` `setInterval(refreshBorrowedBalances, 30000)`. Replace with a `useEffect` that calls invalidate on each `tick` change (or just delete entirely — hook-level tick already covers it) | Same for `components/margin/leverage-assets-tab.tsx`, `components/margin/transfer-collateral.tsx`, `components/margin/collateral-box.tsx`, `components/margin/borrow-box.tsx` |
| Verify Network tab: no 30 s pulse on Reflector price calls; refresh is now driven by ledger close (~5 s) | Same for `components/spot/spot-nonorderbook/SwapCard.tsx`, `components/lite-mode/position-detail.tsx`, `components/farm/add-liquidity.tsx`, `components/farm/remove-liquidity.tsx` |
| **PR `feat/s1-token-prices-tick`** | **PR `feat/s1-mutation-invalidate`** (continued) |

**EOD Checkpoint:** Cross-review each other's PRs (15 min each). Both merge to integration.

---

### Day 3 — Hook Migration (Split by File)

| Dev A (earn + margin) | Dev B (farm + soroswap) |
| --- | --- |
| `hooks/use-earn.ts` — drop `refetchInterval: 30_000` on `usePoolData` and `refetchInterval: 10_000` on `useEarnTransactions`. Add `tick` to both queryKeys. Confirm 4-pool fetch (XLM/USDC/AQUARIUS_USDC/SOROSWAP_USDC) still works after migration. | `hooks/use-soroswap.ts` — drop 60 s `refetchInterval` on `useAllSoroswapPoolStats` + `useSoroswapPoolStats`; drop 10 s on `useSoroswapEvents`. Add `tick` to queryKeys. **Also delete `refreshKey` reads** (lines 78, 101, 125) — the tick replaces them. |
| `hooks/use-margin.ts` — drop `refetchInterval: 10_000` on `useMarginHistory`. Add `tick` to queryKey. (Note: this hook is new since Sprint 1 v1 was drafted.) | `hooks/use-farm.ts` — same pattern. Drop 60 s on `useBlendPoolStats`, `useAllAquariusPoolStats`, `useAquariusPoolStats`. Drop 10 s on `useBlendEvents`, `useAquariusEvents`. **Delete `refreshKey` reads** in all 5 places. |
| Verify each hook invalidates on ledger tick using RQ DevTools | Verify same. Confirm `useAllAquariusLpPositions` (no `refetchInterval` today, but does use `refreshKey`) gets the tick treatment too. |
| **PR `feat/s1-hooks-earn-margin`** | **PR `feat/s1-hooks-farm-soroswap`** |

**Migration pattern (apply to every hook):**

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

**For hooks that read `refreshKey` (use-farm.ts, use-soroswap.ts):** delete the `useBlendStore((s) => s.refreshKey)` line and remove `refreshKey` from the queryKey. The ledger tick replaces it, and Dev B's mutation-invalidate work from Days 1–2 means mutations now hit RQ directly.

**EOD Checkpoint:** Both branches pass `npm run lint && npm run build`. Cross-review + merge. Run a smoke test of the analytics/risk dashboard (Dev B owns) — confirm the simulation `setInterval` in `lib/analytics/oracle-agents/store.ts` is **untouched** and the page still renders.

---

### Day 4 — Cleanup (Split)

| Dev A (refreshKey teardown) | Dev B (audit + smart-polling fate) |
| --- | --- |
| Delete `refreshKey` + `triggerRefresh` from `store/blend-store.ts` (file is 17 lines — likely becomes empty or gets deleted entirely) | Verify: queries write *only* to RQ cache, not Zustand. Audit `useEarnPoolStore.getState().set({...})` calls in `use-earn.ts:48,84` — decide keep (dual-write for legacy consumers) or remove (and migrate readers to RQ) |
| Update the 2 callers: `components/farm/add-liquidity.tsx:61` and `components/farm/remove-liquidity.tsx:30` — replace `triggerBlendRefresh()` with `queryClient.invalidateQueries({ queryKey: ['farm'] })` | Audit `lib/hooks/useSmartPolling.ts` — currently imported by `app/margin/page.tsx` and JSDoc'd in `contexts/query-provider.tsx`. **Decision:** delete it (ledger tick supersedes its purpose) OR keep + document as a fallback primitive. Recommend delete. |
| Verify: `grep -rn "refreshKey\|triggerRefresh" .` returns nothing (excluding `node_modules`) | Update the JSDoc comment in `contexts/query-provider.tsx:11` that still references `useSmartPolling` |
| Update `STATE_MANAGEMENT_ANALYSIS.md` for what changed | Update `IMPLEMENTATION_PLAN.md` "What's done in S1" section to reflect actual end-state |
| **Joint PR `feat/s1-cleanup`** | (same PR) |

**EOD Checkpoint:** All PRs merged into `feat/sprint-1-rewire` integration branch.

---

### Day 5 — Integration Testing (Pair All Day)

Both devs pair on testnet smoke test. Each scenario verifies **both** functional success and reactive (≤5 s) UI update.

**Earn / Lending pool flows (all 4 assets):**

- [ ] Supply XLM → vToken balance updates ≤5 s, no manual refresh
- [ ] Supply USDC, AQUARIUS_USDC, SOROSWAP_USDC → same
- [ ] Withdraw each → balance updates ≤5 s
- [ ] Pool stats (`usePoolData`) refresh on every ledger close

**Margin flows:**

- [ ] Deposit collateral (each asset type) → margin account balance + health factor update ≤5 s
- [ ] Borrow each token → health factor updates in real-time
- [ ] Repay (partial + full) → debt balance updates ≤5 s
- [ ] Transfer collateral → balance updates ≤5 s
- [ ] Withdraw collateral → balance + health factor update
- [ ] `useMarginHistory` shows new tx within one ledger tick (verify against on-chain Stellar Expert)

**Farm flows:**

- [ ] Aquarius: add liquidity to each pool → LP balance updates ≤5 s
- [ ] Aquarius: remove liquidity → same
- [ ] Aquarius events feed shows new tx within one tick
- [ ] Soroswap: add liquidity → LP balance updates ≤5 s
- [ ] Soroswap: swap (each pair) → wallet balance updates ≤5 s
- [ ] Soroswap events feed shows new tx within one tick

**Lite mode + One-click:**

- [ ] Lite home renders and loads positions
- [ ] One-click strategy entry → balances update ≤5 s
- [ ] Position detail page reactive to ledger close

**Risk Dashboard / Analytics (regression — must NOT have been broken by Sprint 1):**

- [ ] `/analytics` route renders
- [ ] Oracle agent simulation tick still firing (sim, NOT chain — verified by `lib/analytics/oracle-agents/store.ts` still using `setInterval` 3 s)
- [ ] Event feed / liquidation / alert pages render with live RPC data

**Idle + visibility:**

- [ ] Idle 5+ min → ledger SSE still attached, but no spurious extra RPC calls. Network tab shows ~1 invalidate burst per ledger close
- [ ] Tab hidden 2+ min → background SSE continues OR backs off cleanly (document chosen behavior)

**Final audit grep (must return nothing outside the allowlist):**

```bash
# Forbidden in chain-data paths:
grep -rn "refetchInterval" hooks/ app/        # should be empty
grep -rn "refreshKey\|triggerRefresh" .       # should be empty
grep -rni "coingecko" .                        # should be empty

# setInterval allowlist (NOT chain data — leave alone):
#   components/faucet/faucet-popup.tsx        — countdown timer
#   components/analytics/layout/Header.tsx    — clock
#   components/ui/carousel.tsx                — slide rotation
#   components/ui/bridging-dialogue.tsx       — animation
#   lib/analytics/oracle-agents/store.ts      — simulation agent tick
```

**Final action:** Squash-merge `feat/sprint-1-rewire` → `new-contract-update`.

---

## Workload Balance

|        | Day 1 | Day 2 | Day 3 | Day 4 | Day 5 |
| ------ | ----- | ----- | ----- | ----- | ----- |
| Dev A  | LedgerProvider (heavy creation, ~6 hrs) | token-prices tick + delete app/page.tsx setInterval | use-earn + use-margin (incl. new `useMarginHistory` + multi-pool verify) | refreshKey teardown + 2 farm-component callsites | Pair test |
| Dev B  | Mutation audit (hook + inline) + 4 hook-level invalidations | ~8 inline component-level mutations | use-farm + use-soroswap (incl. multi-pool aggregators) | SmartPolling audit + dual-write decision + docs | Pair test |

**Net split:**

- **Dev A** owns *creation* + *file deletes* (LedgerProvider, refreshKey teardown).
- **Dev B** owns *surface-area conversion* (many call sites: 4 hook mutations + ~8 inline component mutations).

Hours roughly equal, complementary in skills.

---

## Daily Operating Rhythm

- **9:00 AM** — 15 min standup (Slack huddle in #stellar-development)
  - What I shipped yesterday
  - What I'm doing today
  - Any blockers (especially: am I waiting on LedgerProvider merge?)
- **EOD** — async update in #stellar-development: PRs opened/merged, what's left
- **PR review SLA:** same-day before EOD
- **Pair sessions:** Day 1 morning (2 hrs setup), Day 5 all-day (testing)

---

## Sprint 1 Done When

- [ ] `LedgerSubscriberProvider` wraps app inside `QueryProvider`
- [ ] Zero `refetchInterval` in `hooks/` and `app/` (component-internal UI intervals like carousel are allowed)
- [ ] Zero data-polling `setInterval` outside the allowlist documented above
- [ ] Zero `refreshKey` / `triggerRefresh` references
- [ ] All hook-level + inline component mutations call `queryClient.invalidateQueries` on success (no manual `refreshAllBalances` / `refreshBorrowedBalances` / `triggerRefresh` remain)
- [ ] All hooks invalidate via ledger tick (queryKey includes `tick`)
- [ ] All 4 pools (XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC) verified end-to-end
- [ ] Risk Dashboard + Lite mode pass non-regression smoke test
- [ ] App works end-to-end on testnet

---

## Risk Buffer

- Day 5 has ~6–8 hrs buffer if testing finds bugs
- **Drop-firsts** if behind schedule:
  - `useSmartPolling` deletion → keep as documented unused primitive, defer delete to Sprint 2
  - `STATE_MANAGEMENT_ANALYSIS.md` doc update → defer
  - Dual-write removal in `use-earn.ts` (Zustand `useEarnPoolStore`) → defer to Sprint 2; keep dual-write as long as RQ remains source of truth on writes
- **Hard requirements** (cannot defer):
  - LedgerSubscriberProvider wired
  - All ledger-tick invalidations live for `usePoolData`, `useUserPositions`, `useUserBlendPositions`, `useMarginHistory`, `useAquariusEvents`, `useSoroswapEvents`
  - All 4 hook-level mutations call `invalidateQueries` on success
  - `refreshKey` machinery deleted (it's the smallest, highest-leverage cleanup)

---

## Reference

- **Full implementation plan:** [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- **Architecture research:** [BACKEND_RESEARCH.md](BACKEND_RESEARCH.md)
- **Protocol-tailored plan:** [PROTOCOL_BACKEND_PLAN.md](PROTOCOL_BACKEND_PLAN.md)
- **Combination options:** [BACKEND_OPTIONS.md](BACKEND_OPTIONS.md)
- **Slack channel:** #stellar-development
- **Architecture diagram (IPFS):** https://ipfs.ninja/ipfs/QmdHcwpzeBw3MGhitodadxdPjsmpdcKDpZ5AZAmAt2R9kU

---

*Updated 2026-05-14 against `new-contract-update` branch (Stellar_frontend HEAD `5349509`). v1 of this doc assumed CoinGecko / price-context work was still pending — that's now shipped. v2 re-allocates that budget toward multi-pool verification, the inline-mutation invalidation surface, and Lite-mode + Risk-Dashboard non-regression checks.*
