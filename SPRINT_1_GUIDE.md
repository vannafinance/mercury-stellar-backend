# Sprint 1 Plan — Frontend Rewire (2-Dev Split)

> **Sprint 1 of 6 — Vanna Backend Implementation**
> **Duration:** 5 days · **Team:** 2 frontend devs in parallel
> **Goal:** Zero `setInterval` for chain data. Zero `refetchInterval`. Ledger-tick drives every read. Every mutation migrated to `useMutation` with `onSuccess: invalidateQueries`.
> **Companion doc:** [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (full code stubs + 6-sprint roadmap)
> **Trunk for this sprint:** `main` of this repo (mercury-stellar-backend) — force-synced to Stellar_frontend's `new-contract-update` on 2026-05-14, so it carries the multi-pool contracts (XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC), the Reflector oracle, and Risk Dashboard.
> **Notion source of truth:** https://www.notion.so/Sprint-1-Plan-Frontend-Rewire-2-Dev-Split-36042874c59b80e7a81fdec4d85eb0d7

---

## What Changed Since v1 of This Doc

Sprint 1 v1 was written before `new-contract-update` landed. A re-audit shows some original tasks are already done, and new ones are in scope. **Mutation strategy stays per v1: full `useMutation` migration.**

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
- All mutations are still imperative wrappers (no `useMutation` migration yet).

### New scope added since v1 was written

| Area | Detail |
| ---- | ------ |
| Multi-pool ASSET_TYPES | `AQUARIUS_USDC` and `SOROSWAP_USDC` added alongside `XLM`/`USDC`. Every read path that lists pools must include all 4. `usePoolData` already does — verify the rest. |
| `useMarginHistory` | New hook in `hooks/use-margin.ts:7` — 10 s `refetchInterval`. Needs ledger tick. |
| `useAllAquariusPoolStats` / `useAllSoroswapPoolStats` | New multi-pool aggregators — 60 s `refetchInterval`. Needs tick. |
| Risk Dashboard & Analytics pages | New `lib/analytics/`, `lib/risk/`, `components/analytics/`. Uses `setInterval` for **simulation agent tick** (`lib/analytics/oracle-agents/store.ts`). **Scope out:** this is simulation, not chain data. Document in audit allowlist. |
| Lite Mode | New `components/lite-mode/`, `lib/one-click-strategy.ts`, `lib/hooks/useLiteModeGuard.ts`. Smoke-test path on Day 5. |
| `MarginAccountService.getMarginTransactionHistory` | New on-chain history reader — already in a query, just needs tick. |

### Mutation strategy — full `useMutation` migration (per v1)

Every mutation gets migrated to `@tanstack/react-query`'s `useMutation`. Each one wires `onSuccess: () => queryClient.invalidateQueries(...)` against the right key. The manual `refreshAllBalances()` / `refreshBorrowedBalances()` / `triggerRefresh()` calls get deleted — RQ cache becomes the single source of truth.

**Scope grounded in `new-contract-update` code (audited 2026-05-14):**

| Where | What exists today | Target |
| --- | --- | --- |
| `hooks/use-earn.ts:227` | `useSupplyLiquidity` — imperative wrapper returning `{ supply, isLoading, message }`, calls `refreshAllBalances()` after deposit | Migrate to `useMutation`, drop manual refresh |
| `hooks/use-earn.ts:350` | `useWithdrawLiquidity` — same pattern | Migrate to `useMutation`, drop manual refresh |
| `hooks/use-wallet.ts:199` | `useDeposit` — wraps `ContractService.deposit` | Migrate to `useMutation` |
| `hooks/use-wallet.ts:276` | `useWithdraw` — wraps `ContractService.withdraw` | Migrate to `useMutation` |
| `components/margin/repay-loan-tab.tsx` | Inline mutation calling `refreshBorrowedBalances` | Extract into a local `useMutation`, drop manual refresh |
| `components/margin/leverage-assets-tab.tsx`, `transfer-collateral.tsx`, `collateral-box.tsx`, `borrow-box.tsx` | Same inline pattern (4 files) | Same — extract to `useMutation` |
| `components/spot/spot-nonorderbook/SwapCard.tsx`, `components/lite-mode/position-detail.tsx` | Inline mutations on swap / one-click | Same |
| `components/farm/add-liquidity.tsx:61`, `components/farm/remove-liquidity.tsx:30` | Call `triggerBlendRefresh()` after tx | Migrate to `useMutation` with `onSuccess: invalidateQueries({ queryKey: ['farm'] })` |

**4 hook-level + ~8 inline component-level = ~12 mutation sites to convert.**

**Caller impact:** the 4 hook-level mutations currently expose `{ supply, isLoading, message }` (or equivalent). After migration callers switch to the mutation object: `{ mutate, mutateAsync, isPending, error, isSuccess }`. The `message` toast UX (currently `useState` inside the hook) moves into the caller — read `mutation.error?.message` on failure, react to `mutation.isSuccess` for success. Plan on touching ~10–15 caller sites across `components/earn/`, `components/margin/`, `components/spot/`, `components/lite-mode/`, `app/page.tsx` while converting each hook.

**Note on existing comment in `hooks/use-earn.ts:223-225`** (current code says imperative wrappers are intentional): that comment is now outdated and gets deleted as part of this migration. The full `useMutation` end-state is what the sprint commits to.

---

## Strategy

Sprint 1 me 5 days of work hai for 1 dev. 2 devs ke saath parallel tracks chala ke same 5 days me khatam karenge with **safety buffer** + better integration testing.

**Critical dependency:** Day 1 ko `LedgerSubscriberProvider` build hona MUST hai — baki saara kaam `useLedgerTick` hook par depend karta hai. Isiliye Dev A Day 1 par usi pe focused hai, Dev B parallel me `useMutation` conversion shuru karta hai (jo independent hai — `useMutation` already in TanStack Query, no new deps).

**Net delta vs v1:** ~1.5 dev-days of Sprint 1 scope is already done (CoinGecko removal + price-context delete). That budget is being re-spent on multi-pool verification, inline-mutation `useMutation` extraction, and the lite-mode + Risk-Dashboard smoke path on Day 5 — so calendar is unchanged but coverage is wider.

---

## Branching Strategy

```
main                                          (mercury-stellar-backend — synced to new-contract-update)
  └─ feat/sprint-1-rewire                     (integration branch)
       ├─ feat/s1-ledger-provider             (Dev A — Day 1)
       ├─ feat/s1-token-prices-tick           (Dev A — Day 2)
       ├─ feat/s1-hooks-earn-margin           (Dev A — Day 3)
       ├─ feat/s1-mutations                   (Dev B — Day 1–2)
       ├─ feat/s1-hooks-farm-soroswap         (Dev B — Day 3)
       └─ feat/s1-cleanup                     (split — Day 4)
```

- **Trunk is `main` of mercury-stellar-backend** (force-synced to Stellar_frontend's `new-contract-update` on 2026-05-14). All Sprint 1 branches already exist on origin pointing at the same commit. Day 5 EOD: integration branch → `main` (squash merge).
- Daily PRs into the integration branch.
- Each branch must pass `npm run lint && npm run build` before merge.

---

## Day-by-Day Split

### Day 1 — Foundation + Parallel Mutation Start

**Morning (pair, ~2 hrs):**

- [ ] Both devs: pull contract addresses for the 4 pools (XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC); set up `.env.local` per Sprint 0 prereqs
- [ ] Both devs: verify Soroban testnet RPC + Horizon SSE working with curl
- [ ] Both devs: `git checkout main && git pull && git checkout feat/sprint-1-rewire` (already exists on origin)

**Afternoon (split):**

| Dev A (foundation track) | Dev B (useMutation track) |
| --- | --- |
| Build `contexts/ledger-subscriber.tsx` (full code from `IMPLEMENTATION_PLAN.md` L140–225). Subscribe via Horizon `streamLedgers` SSE; expose `useLedgerTick()` → `{ tick, lastLedgerSeq }` | Audit every mutation site — both hook-level *and* inline component-level. Produce a checklist: `grep -rn "ContractService\." hooks/ components/ app/` |
| Wrap `app/layout.tsx` with `<LedgerSubscriberProvider>` *inside* `<QueryProvider>` so it can call `queryClient.invalidateQueries` | Convert `useSupplyLiquidity` (hooks/use-earn.ts:227) to `useMutation`. Wire `onSuccess: () => qc.invalidateQueries({ queryKey: ['earn'] })`. Delete inline `refreshAllBalances()`. Update callers from `{ supply, isLoading, message }` to `{ mutate, isPending, error }`. |
| Verify DevTools: `tick` increments every ~5 s, no console errors, RQ DevTools shows invalidations firing | Convert `useWithdrawLiquidity` (hooks/use-earn.ts:350), `useDeposit` (hooks/use-wallet.ts:199), `useWithdraw` (hooks/use-wallet.ts:276) — same pattern. |
| **PR `feat/s1-ledger-provider` → review → merge** ⚡ blocker for Day 2+ | Open `feat/s1-mutations` PR (work continues Day 2) |

**EOD Checkpoint:** LedgerProvider merged into integration. Dev B can now use `useLedgerTick` from Day 2. All 4 hook-level mutations converted to `useMutation` (PR open, not yet merged).

---

### Day 2 — Branch Out

| Dev A (token-prices + page-level setInterval) | Dev B (inline component-level mutations → useMutation) |
| --- | --- |
| Rewire `hooks/use-token-prices.ts:47`: drop the 30 s `setInterval(refresh, REFRESH_INTERVAL_MS)`. Wrap `useTokenPrices` in `useQuery` with `queryKey: ['oracle','prices', sortedSymbols, tick]` | Extract inline mutation in `components/margin/repay-loan-tab.tsx` into a `useMutation`. `onSuccess` invalidates `['margin']`. Delete the `refreshBorrowedBalances(...)` call. |
| Delete `app/page.tsx:115` `setInterval(refreshBorrowedBalances, 30000)`. Replace with a `useEffect` that calls invalidate on each `tick` change (or just delete entirely — hook-level tick already covers it) | Same for `components/margin/leverage-assets-tab.tsx`, `components/margin/transfer-collateral.tsx`, `components/margin/collateral-box.tsx`, `components/margin/borrow-box.tsx` (4 files) |
| Verify Network tab: no 30 s pulse on Reflector price calls; refresh is now driven by ledger close (~5 s) | Same for `components/spot/spot-nonorderbook/SwapCard.tsx`, `components/lite-mode/position-detail.tsx`, `components/farm/add-liquidity.tsx` (replace `triggerBlendRefresh` with `qc.invalidateQueries({ queryKey: ['farm'] })`), `components/farm/remove-liquidity.tsx` |
| **PR `feat/s1-token-prices-tick`** | **PR `feat/s1-mutations`** (continued — finalize + merge) |

**EOD Checkpoint:** Cross-review each other's PRs (15 min each). Both merge to integration. All ~12 mutation sites now on `useMutation`.

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

**Mutation pattern (from Days 1–2, for reference):**

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

**For hooks that read `refreshKey` (use-farm.ts, use-soroswap.ts):** delete the `useBlendStore((s) => s.refreshKey)` line and remove `refreshKey` from the queryKey. The ledger tick replaces it, and Dev B's `useMutation` work from Days 1–2 means mutations invalidate RQ keys directly on success.

**EOD Checkpoint:** Both branches pass `npm run lint && npm run build`. Cross-review + merge. Run a smoke test of the analytics/risk dashboard (Dev B owns) — confirm the simulation `setInterval` in `lib/analytics/oracle-agents/store.ts` is **untouched** and the page still renders.

---

### Day 4 — Cleanup (Split)

| Dev A (refreshKey teardown) | Dev B (audit + smart-polling fate) |
| --- | --- |
| Delete `refreshKey` + `triggerRefresh` from `store/blend-store.ts` (file is 17 lines — likely becomes empty or gets deleted entirely) | Verify: queries write *only* to RQ cache, not Zustand. Audit `useEarnPoolStore.getState().set({...})` calls in `use-earn.ts:48,84` — decide keep (dual-write for legacy consumers) or remove (and migrate readers to RQ) |
| Confirm no remaining `triggerBlendRefresh()` callers in `components/farm/*` (Day 2 handled them — re-grep to be sure) | Audit `lib/hooks/useSmartPolling.ts` — currently imported by `app/margin/page.tsx` and JSDoc'd in `contexts/query-provider.tsx`. **Decision:** delete it (ledger tick supersedes its purpose) OR keep + document as a fallback primitive. Recommend delete. |
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
- [ ] Mutations expose `isPending` correctly (button disabled state) + surface errors via `mutation.error.message`

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
grep -rn "refreshAllBalances\|refreshBorrowedBalances" .   # should be empty

# setInterval allowlist (NOT chain data — leave alone):
#   components/faucet/faucet-popup.tsx        — countdown timer
#   components/analytics/layout/Header.tsx    — clock
#   components/ui/carousel.tsx                — slide rotation
#   components/ui/bridging-dialogue.tsx       — animation
#   lib/analytics/oracle-agents/store.ts      — simulation agent tick
```

**Final action:** Squash-merge `feat/sprint-1-rewire` → `main`.

---

## Workload Balance

|        | Day 1 | Day 2 | Day 3 | Day 4 | Day 5 |
| ------ | ----- | ----- | ----- | ----- | ----- |
| Dev A  | LedgerProvider (heavy creation, ~6 hrs) | token-prices tick + delete app/page.tsx setInterval | use-earn + use-margin (incl. new `useMarginHistory` + multi-pool verify) | refreshKey teardown + sanity-check farm callsites | Pair test |
| Dev B  | Audit + convert 4 hook-level mutations to `useMutation` (use-earn × 2, use-wallet × 2) | Convert ~8 inline component-level mutations to `useMutation` | use-farm + use-soroswap (incl. multi-pool aggregators) | SmartPolling audit + dual-write decision + docs | Pair test |

**Net split:**

- **Dev A** owns *creation* + *file deletes* (LedgerProvider, refreshKey teardown).
- **Dev B** owns *mutation surface conversion* — ~12 mutation sites migrated to `useMutation` + caller refactors (~10–15 caller sites).

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
- [ ] All hook-level + inline component mutations migrated to `useMutation`, each with `onSuccess: () => queryClient.invalidateQueries(...)` (no manual `refreshAllBalances` / `refreshBorrowedBalances` / `triggerRefresh` remain)
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
  - **Inline component mutations** — if running out of time on Day 2, leave 2–3 of them imperative and finish in Sprint 2 (but hook-level 4 mutations are non-negotiable)
- **Hard requirements** (cannot defer):
  - LedgerSubscriberProvider wired
  - All ledger-tick invalidations live for `usePoolData`, `useUserPositions`, `useUserBlendPositions`, `useMarginHistory`, `useAquariusEvents`, `useSoroswapEvents`
  - 4 hook-level mutations (`useSupplyLiquidity`, `useWithdrawLiquidity`, `useDeposit`, `useWithdraw`) migrated to `useMutation`
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

*Updated 2026-05-14 against `new-contract-update` (Stellar_frontend HEAD `5349509`, now mirrored as `main` of mercury-stellar-backend). v1 of this doc assumed CoinGecko / price-context work was still pending — that's now shipped. v2 re-allocates that budget toward multi-pool verification, the inline-mutation `useMutation` migration surface, and Lite-mode + Risk-Dashboard non-regression checks. **Mutation strategy follows v1: full `useMutation` migration for all hook-level + inline mutations.***
