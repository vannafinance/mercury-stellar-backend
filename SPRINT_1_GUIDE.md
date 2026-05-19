# Sprint 1 Plan — Stellar Integration Upgrade & Optimization (30-Day, 2-Dev Split)

> **Sprint 1 v3 — Vanna Backend Implementation**
> **Duration:** 30 calendar days · **Start:** 2026-05-19 · **Target end:** 2026-06-17
> **Team:** Phase 1 (Days 1–7) — Sanujit solo · Phase 2 (Days 8–30) — Sanujit + Divyansh in parallel
> **Goal:** Zero `setInterval` for chain data. Zero `refetchInterval`. Ledger-tick drives every read. Every mutation migrated to `useMutation` with `onSuccess: invalidateQueries`. Plus: test infrastructure, optimistic updates, analytics perf, dual-write consolidation, type safety.
> **Companion doc:** [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
> **Trunk:** `main` of mercury-stellar-backend (merged with Stellar_frontend's `new-contract-update` on 2026-05-19 via merge commit `7c25ac7`; carries multi-pool contracts XLM/USDC/AQUARIUS_USDC/SOROSWAP_USDC, Reflector oracle, Risk Dashboard, the HF/net-earning fix, one-click APY-live, Blend liquidity HF bug fix, and LP-token deposit tracking fix).
> **Notion source of truth:** https://www.notion.so/Sprint-1-Plan-Frontend-Rewire-2-Dev-Split-36042874c59b80e7a81fdec4d85eb0d7

---

## What Changed in v3

v2 of this doc (2026-05-14) was a 5-day plan for 2 devs working in parallel. v3 stretches that to **30 days** for two reasons:

1. **Dev A unavailable for first 7 days** — Sanujit owns the entire foundation + mutation surface solo before Divyansh joins on Day 8.
2. **Scope expansion** — original 6-sprint roadmap compressed into this single 30-day sprint: test infra, unified error UX, optimistic updates, analytics perf, dual-write consolidation, type safety pass, and documentation.

**Mutation strategy stays per v1/v2: full `useMutation` migration.** This decision is locked.

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

**Phase 2 (Days 8–30) — Two-dev parallel:** Divyansh joins. Both devs work in parallel tracks. The hook `refetchInterval` migration splits cleanly (earn+margin vs farm+soroswap), and from Day 13 onward the work fans out into independent optimization streams (test infra, optimistic updates, analytics perf, etc.) that don't share files.

**Net vs v2:** v2 budgeted 10 dev-days for 2 devs over 5 calendar days. v3 budgets ~7 solo dev-days (Phase 1) + ~46 dev-days for 2 devs over 23 calendar days (Phase 2) = ~53 dev-days total. The extra ~43 dev-days fund: test infra (~6), unified error UX (~4), optimistic updates (~6), analytics perf (~6), dual-write consolidation (~2), type safety (~4), docs (~2), bug bash + e2e (~4), buffer (~9).

---

## Branching Strategy

```
main                                                  (mercury-stellar-backend — merge 7c25ac7 from new-contract-update)
  └─ feat/stellar-optimization-30d                    (long-lived integration branch — cuts from main 2026-05-19)
       │
       │  ── Phase 1 (Sanujit, solo) ──
       ├─ s1/ledger-provider                          (D1–2)
       ├─ s1/mutations-hook                           (D3–4 — useSupplyLiquidity, useWithdrawLiquidity, useDeposit, useWithdraw)
       ├─ s1/token-prices-tick                        (D5)
       ├─ s1/mutations-inline                         (D6–7 — 8 inline component mutations)
       │
       │  ── Phase 2 (Sanujit + Divyansh, parallel) ──
       ├─ s1/hooks-tick-earn-margin                   (D8–10  · Dev A)
       ├─ s1/hooks-tick-farm-soroswap                 (D8–10  · Dev B)
       ├─ s1/cleanup-refreshkey                       (D11)
       ├─ s1/cleanup-smartpolling                     (D12)
       ├─ s2/test-infra-services                      (D13–15 · Dev A)
       ├─ s2/test-infra-hooks                         (D13–15 · Dev B)
       ├─ s3/error-ux                                 (D16–17)
       ├─ s3/optimistic-earn                          (D18–20 · Dev A)
       ├─ s3/optimistic-margin                        (D18–20 · Dev B)
       ├─ s4/perf-analytics                           (D21–23 · Dev A)
       ├─ s4/perf-risk-dashboard                      (D21–23 · Dev B)
       ├─ s4/dual-write-cleanup                       (D24)
       ├─ s4/typesafety                               (D25–26)
       ├─ s4/docs                                     (D27)
       └─ s4/release                                  (D28–30 — bug bash + final integration → squash to main)
```

**Rules:**

- **Trunk is `main`** of mercury-stellar-backend.
- **Integration branch** `feat/stellar-optimization-30d` collects all 17 phase branches. Each phase branch PRs into the integration branch.
- **Old v2 branches** (`feat/sprint-1-rewire`, `feat/s1-*`) remain on origin as reference — do not delete.
- **Daily PRs** into the integration branch. Cross-review SLA: same-day before EOD (Phase 2).
- **Each branch must pass** `npm run lint && npm run build` before merge.
- **Day 30 EOD:** integration branch → `main` via squash merge.

---

## Phase 1 — Solo Foundation (Days 1–7, Sanujit)

### Day 1 — LedgerSubscriberProvider (scaffold)

- [ ] `git checkout main && git pull` → `git checkout -b s1/ledger-provider feat/stellar-optimization-30d`
- [ ] Verify Soroban testnet RPC + Horizon SSE working with curl
- [ ] Build `contexts/ledger-subscriber.tsx` from `IMPLEMENTATION_PLAN.md` L140–225. Subscribe via Horizon `streamLedgers` SSE; expose `useLedgerTick()` → `{ tick, lastLedgerSeq }`
- [ ] Wrap `app/layout.tsx` with `<LedgerSubscriberProvider>` *inside* `<QueryProvider>` so it can call `queryClient.invalidateQueries`

### Day 2 — LedgerProvider verify + merge

- [ ] DevTools: `tick` increments every ~5 s, no console errors, RQ DevTools shows invalidations firing on tick
- [ ] Handle: SSE reconnect on network drop, tab visibility (continue or back off — pick + document)
- [ ] `npm run lint && npm run build` clean
- [ ] **PR `s1/ledger-provider` → integration branch** ⚡ unblocks all later tick wiring

### Day 3 — Hook-level mutations (earn)

- [ ] `git checkout -b s1/mutations-hook feat/stellar-optimization-30d`
- [ ] Convert `useSupplyLiquidity` (`hooks/use-earn.ts:227`) to `useMutation`. Wire `onSuccess: () => qc.invalidateQueries({ queryKey: ['earn'] })`. Delete inline `refreshAllBalances()`.
- [ ] Convert `useWithdrawLiquidity` (`hooks/use-earn.ts:350`). Same pattern.
- [ ] Delete the outdated comment at `hooks/use-earn.ts:223–225` ("Mutations — stay imperative")
- [ ] Update callers: `{ supply, isLoading, message }` → `{ mutate, mutateAsync, isPending, error, isSuccess }`. Toast UX moves to the caller via `mutation.error?.message` / `mutation.isSuccess`. Expect to touch ~5 caller sites in `components/earn/`, `app/earn/page.tsx`.

### Day 4 — Hook-level mutations (wallet)

- [ ] Convert `useDeposit` (`hooks/use-wallet.ts:199`) to `useMutation`. Invalidate `['earn']` + `['margin']` as appropriate.
- [ ] Convert `useWithdraw` (`hooks/use-wallet.ts:276`). Same pattern.
- [ ] Caller refactors: `app/page.tsx`, `app/earn/page.tsx`, `components/wallet/*` (~3–5 sites)
- [ ] `npm run lint && npm run build` clean
- [ ] **PR `s1/mutations-hook` → integration branch**

### Day 5 — token-prices tick + setInterval cleanup

- [ ] `git checkout -b s1/token-prices-tick feat/stellar-optimization-30d`
- [ ] Rewire `hooks/use-token-prices.ts:47`: drop 30 s `setInterval(refresh, REFRESH_INTERVAL_MS)`. Wrap `useTokenPrices` in `useQuery` with `queryKey: ['oracle','prices', sortedSymbols, tick]`
- [ ] Delete `app/page.tsx:114` `setInterval(refreshBorrowedBalances, 30000)`. Hook-level tick on `useMarginHistory` + `useUserPositions` (after Phase 2 D8–10) replaces it. Interim: keep a `useEffect` that invalidates `['margin']` on tick change.
- [ ] Verify Network tab: no 30 s pulse on Reflector price calls; refresh is now ledger-close (~5 s)
- [ ] **PR `s1/token-prices-tick` → integration branch**

### Day 6 — Inline mutations (margin)

- [ ] `git checkout -b s1/mutations-inline feat/stellar-optimization-30d`
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

### Day 11 — `refreshKey` teardown + 4-pool verify

- Dev A: Delete `refreshKey` + `triggerRefresh` from `store/blend-store.ts` (file is 17 lines — likely empty or gets deleted). Confirm no remaining `triggerBlendRefresh()` callers.
- Dev B: 4-pool end-to-end verify on testnet — supply/withdraw/borrow/repay each of XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC. Confirm balance updates ≤5 s without manual refresh.
- Final grep: `grep -rn "refreshKey\|triggerRefresh" .` returns nothing.
- **Joint PR `s1/cleanup-refreshkey`**.

### Day 12 — `useSmartPolling` decision + first integration smoke

- Dev A: Delete `lib/hooks/useSmartPolling.ts`. Remove import from `app/margin/page.tsx`. Update JSDoc in `contexts/query-provider.tsx:11`.
- Dev B: First full integration smoke pass on testnet (supply, borrow, swap, add liquidity, remove liquidity across all 4 pools). Document any bugs surfaced.
- **PR `s1/cleanup-smartpolling`**.

### Days 13–15 — Test infrastructure

| Dev A (services) | Dev B (hooks) |
| --- | --- |
| Install vitest + happy-dom. Configure for ESM + TS. Add `npm run test` script. | Install React Testing Library. Configure with vitest. |
| Unit tests: `ContractService.deposit`/`withdraw`/`getPoolStats` happy + failure path. Mock Soroban client at the `rpcServer` boundary. | Hook tests: `useLedgerTick` (mocks Horizon SSE), `useSupplyLiquidity` (`renderHook` + `act` for mutation lifecycle, RQ provider wrapper). |
| Unit tests: `MarginAccountService.getMarginTransactionHistory`, repay/borrow service-layer paths. | Hook tests: `usePoolData` tick-driven invalidation, `useEarnTransactions`. |
| Aim: ~30 service-layer tests across 4 services. | Aim: ~15 hook tests. |
| **PR `s2/test-infra-services`** | **PR `s2/test-infra-hooks`** |

### Days 16–17 — Unified mutation error/toast UX

Both devs: replace ad-hoc `useState({type:'',text:''})` patterns in 12 mutation callers with a single hook (e.g., `useMutationToast(mutation, { success, error })`). One toast lib (sonner or react-hot-toast — pick first). Error normalization centralised in `lib/errors/normalize.ts` (replaces ad-hoc `normalizeSupplyError`, `normalizeWithdrawError` in `use-earn.ts`).

**Joint PR `s3/error-ux`**.

### Days 18–20 — Optimistic updates

| Dev A (earn supply/withdraw) | Dev B (margin borrow/repay) |
| --- | --- |
| `onMutate`: snapshot current `['earn', 'positions', ...]` cache, write predicted post-deposit balance. | `onMutate`: snapshot `['margin', ...]`, write predicted post-borrow debt + HF. |
| `onError`: rollback to snapshot. | `onError`: rollback. |
| `onSettled`: invalidate to reconcile with on-chain truth. | `onSettled`: invalidate. |
| Visual: supply button shows "Confirming…" but balance updates immediately, snaps back if tx fails. | Visual: borrow shows new HF immediately; rolls back on revert. |
| **PR `s3/optimistic-earn`** | **PR `s3/optimistic-margin`** |

### Days 21–23 — Analytics + Risk Dashboard perf

| Dev A (analytics) | Dev B (risk explorer) |
| --- | --- |
| Audit `lib/analytics/onchain/derivations.ts` — memoize heavy reduce/map chains. | Audit `components/analytics/risk-explorer/BadDebtMonitorSummary.tsx` — derive once per render, not per row. |
| `PositionsMonitor.tsx` — React DevTools profile, eliminate redundant re-renders (likely missing `useMemo` on derived rows). | Bisect Risk Dashboard render cost — find the heaviest sub-tree, optimize. |
| Confirm `lib/analytics/oracle-agents/store.ts` simulation `setInterval` stays untouched (allowlist). | Confirm event feed pagination doesn't re-fetch on every tick. |
| **PR `s4/perf-analytics`** | **PR `s4/perf-risk-dashboard`** |

### Day 24 — Zustand dual-write consolidation

- Audit `useEarnPoolStore.getState().set({...})` calls in `use-earn.ts:48,84`. Decide: remove (and migrate readers to RQ) or keep (and document why dual-write is intentional).
- Same audit for `store/margin-account-info-store.ts` — `refreshBorrowedBalances` writes at L148, 160, 195.
- Recommend remove unless a non-RQ legacy reader is found.
- **Joint PR `s4/dual-write-cleanup`**.

### Days 25–26 — Type safety pass

| Dev A | Dev B |
| --- | --- |
| Tighten service-layer return types: `ContractService`, `MarginAccountService`, `BlendService`, `AquariusService`, `SoroswapService`. Replace any `any` / loose return shapes. | Tighten hook return types — explicit interfaces for `usePoolData`, `useUserPositions`, `useMarginHistory`, `useAll*PoolStats`. |
| `npm run lint` strict + no warnings. | Same. |
| **Joint PR `s4/typesafety`**. | (same PR) |

### Day 27 — Documentation

- Update `SPRINT_1_GUIDE.md` (this doc) — mark each Phase 2 step done.
- Update `IMPLEMENTATION_PLAN.md` "What's done in S1" section.
- Write new `ARCHITECTURE.md` summarizing post-sprint state: ledger-tick model, mutation pattern, store/RQ split, test layout.
- Update `contexts/query-provider.tsx` JSDoc.
- **Joint PR `s4/docs`**.

### Days 28–29 — Bug bash + full testnet e2e

Both devs pair. Run every flow from v2's Day 5 checklist (Earn × 4 assets, Margin × 4 assets, Farm × Aquarius + Soroswap, Lite + One-click, Risk Dashboard regression). Each scenario verifies functional success AND reactive UI update ≤5 s.

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
- Squash-merge `feat/stellar-optimization-30d` → `main`
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
- **Pair sessions:** Day 11 (4-pool verify), Day 24 (dual-write consolidation), Days 28–29 (bug bash + e2e)

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
- [ ] **NEW v3:** Type safety pass — zero `any` in service + hook return types
- [ ] **NEW v3:** `ARCHITECTURE.md` written
- [ ] App works end-to-end on testnet

---

## Risk Buffer

- Days 28–29 have ~12 hrs total buffer for bugs found in the bug bash
- **Drop-firsts** if behind schedule:
  - Day 27 docs (`ARCHITECTURE.md`) → defer to post-sprint
  - Day 24 dual-write consolidation → keep dual-write, document and defer
  - Day 12 `useSmartPolling` delete → keep + document, defer delete
  - Type safety pass (D25–26) — partial completion acceptable
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

*Updated 2026-05-19 as v3. v2 (2026-05-14) was a 5-day plan for 2 devs in parallel. v3 expands to 30 days because Dev A (Divyansh) is unavailable for the first 7 days, and scope grows to absorb test infrastructure, optimistic updates, unified error UX, analytics perf, dual-write consolidation, type safety, and documentation that the original 6-sprint roadmap had spread across later sprints. **Mutation strategy is unchanged from v1/v2: full `useMutation` migration for all hook-level + inline mutations.***
