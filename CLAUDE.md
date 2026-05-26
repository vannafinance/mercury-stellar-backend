# Project Guide — mercury-stellar-backend

> Auto-loaded for every Claude Code session in this repo. Keep concise.
> Source of truth for the sprint plan is [SPRINT_1_GUIDE.md](SPRINT_1_GUIDE.md).

---

## What this project is

Vanna Finance's Stellar-side frontend + on-chain integration. Next.js (App Router)
+ TanStack Query + Zustand, talking to Soroban contracts via the Stellar SDK and
Horizon. Four pools live: XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC.

## Active sprint

**Sprint 1 v3.1 — 30 days, started 2026-05-19, target 2026-06-17.**
Integration branch: `feat/stellar-rewire`. Trunk: `main`.

- **Phase 1 (D1–7)** — solo Sanujit (Dev A) — **complete** as of 2026-05-25.
  - LedgerSubscriberProvider live ([contexts/ledger-subscriber.tsx](contexts/ledger-subscriber.tsx))
  - All 12 mutation sites on `useMutation` with `onSuccess: invalidateQueries`
  - `hooks/use-token-prices.ts` driven by ledger tick
  - `app/page.tsx` 30s `setInterval(refreshBorrowedBalances)` deleted
- **Phase 2 (D8–30)** — Sanujit (Dev A) + Rohit (Dev B) parallel. Started D8 = 2026-05-26.
  - **D8–10 — complete.** Hook tick migration shipped: PR #11 (earn+margin) and
    PR #12 (farm+soroswap) merged into `feat/stellar-rewire`. All 18 read hooks on
    the stable-queryKey + invalidate-on-tick pattern. `refetchInterval` count: 0.
  - **Sync (2026-05-27) — landed.** PR #13 merged `stellar-frontend/new-contract-update`
    (through `de77db7`) into the rewire: BigInt collateral math, Aquarius reserve-order
    fix, positions/repay calc updates, `capAmountToMaxBalance` swap helper. See the
    "Known debt from the sync" note below — it added a polling `PriceProvider` that
    D12 will reconcile.
  - **Next:** D11 (refreshKey teardown), D12 (kill remaining polling — `useSmartPolling`
    **and** the new `PriceProvider` 60s poll).
  - **New S1 scope (D25):** stats snapshot-cache layer (`/api/account/[addr]` +
    `/api/pools` edge routes, read via the ledger-tick RQ pattern) to fix slow
    cold-load of **all** stats panels (Margin/Earn/Farm/Portfolio). Pulled in from
    S2/S3. See [SPRINT_1_GUIDE.md](SPRINT_1_GUIDE.md) D25.
  - **Codebase audit (2026-05-27):** full health audit in [CODEBASE_AUDIT.md](CODEBASE_AUDIT.md).
    Hook layer clean; remaining issues cluster in the margin Zustand path, farm/repay/
    lite components, and the analytics island. Items folded into D11/D12/D16–17/D22/
    D25/D26. **Analytics-island rework (5 polling pages + bespoke store + unbounded
    all-accounts read) pulled into S1 (D22)**, riding Mercury/Hubble.

See [SPRINT_1_GUIDE.md](SPRINT_1_GUIDE.md) for the day-by-day plan and Phase 2
track assignments.

## Known debt from the new-contract-update sync (reconcile in D12)

The 2026-05-27 sync brought in upstream's `contexts/price-context.tsx` — a
`PriceProvider` that polls XLM price on a **60s `setInterval`** (the exact
chain-data polling anti-pattern this sprint removes). It is currently mounted in
[app/layout.tsx](app/layout.tsx) nested inside `LedgerSubscriberProvider`, and we
kept it intact so the sync's calc changes work. Result: **two token-price systems
coexist** —

- `hooks/use-token-prices.ts` — tick-driven, our pattern (16 consumers, `useTokenPrices(tokens[])` → price map).
- `contexts/price-context.tsx` — 60s poll, upstream (7 consumers, `useTokenPrices()` → `{prices,getPrice,xlmUsd,…}`).
- 7 files import **both** (the second aliased `useTokenPricesFromHook`).

**D12 plan:** collapse `PriceProvider`'s 60s poll onto the ledger tick (or retire it
in favour of `hooks/use-token-prices.ts`), then drop the dual `useTokenPrices` API
so there is one source of truth. Until then, **do not add new `PriceProvider`
consumers** — use `hooks/use-token-prices.ts`.

## Two locked patterns — match these exactly in new code

### 1. Ledger-tick driven reads (replaces all chain-data `setInterval` / `refetchInterval`)

**Keep the queryKey stable. Invalidate on tick via `useEffect`.** Do NOT put
`tick` in the queryKey — each new key value creates a fresh cache slot with
no data, which forces `query.isLoading = true` on every ledger close and
causes the UI to flicker to a "Loading…" state every ~5 s.

```ts
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLedgerTick } from '@/contexts/ledger-subscriber';

const qc = useQueryClient();
const { tick } = useLedgerTick();
const lastTickRef = useRef(tick);

const query = useQuery({
  queryKey: ['earn', 'pools'],   // STABLE — survives across ticks
  queryFn: ...,
  staleTime: 4_000,
  // refetchInterval: REMOVED
});

useEffect(() => {
  if (tick === lastTickRef.current) return;   // skip initial mount
  lastTickRef.current = tick;
  qc.invalidateQueries({ queryKey: ['earn', 'pools'] });
}, [tick, qc]);
```

`LedgerSubscriberProvider` is mounted in `app/layout.tsx` *inside*
`<QueryProvider>` so `queryClient.invalidateQueries` works.

### 2. Mutations on `useMutation` with cache invalidation

```ts
const qc = useQueryClient();
return useMutation({
  mutationFn: async (args) => { ... },
  onSuccess: () => qc.invalidateQueries({ queryKey: ['earn'] }),
});
```

No manual `refreshAllBalances()` / `refreshBorrowedBalances()` /
`triggerBlendRefresh()` calls. RQ cache is the single source of truth.
Callers consume `{ mutate, mutateAsync, isPending, error, isSuccess }`;
toasts/UX wire to `mutation.error?.message` and `mutation.isSuccess`.

### 3. Loading flags — stale-while-revalidate, no flicker

```ts
return {
  data: query.data ?? fallback,
  isLoading: query.isLoading,                          // initial mount only
  isRefreshing: query.isFetching && !query.isLoading,  // optional opt-in
  error: ...,
  refresh: () => query.refetch(),
};
```

**Never** `isLoading: query.isLoading || query.isFetching`. With 5 s ledger
ticks every background refetch would flip `isFetching` true and any
`{isLoading ? <Spinner/> : <Stats/>}` consumer wipes content from the screen.
Show stale data, refetch silently, swap when ready. Pages must not gate
content rendering on `isRefreshing`.

### Anti-patterns to delete on sight

- `refetchInterval: N_000` on any chain-data query → replace with the stable-queryKey + invalidate-on-tick pattern in #1 above.
- `queryKey: [..., tick]` → changing the queryKey on every tick creates fresh cache slots and forces `isLoading: true` every ledger close. Use the invalidate-on-tick pattern instead.
- `setInterval(..., 30_000)` for chain refresh → use a `useEffect` on `tick` if a
  one-shot side effect is needed. **Known exception today:** `contexts/price-context.tsx`
  still has a 60s `setInterval` from the sync — slated for removal in D12, don't copy it.
- `isLoading: query.isLoading || query.isFetching` → drop the OR. See pattern #3 above.
- New `PriceProvider` (`@/contexts/price-context`) consumers → use the tick-driven
  `hooks/use-token-prices.ts` instead. The two coexist post-sync; D12 collapses them.
- `refreshKey` reads from `useBlendStore` → these are being torn out across
  Phase 2 D8–11. Don't add new ones.
- `useState({ type: '', text: '' })` toast patterns in mutation callers → being
  replaced with a single mutation-toast hook in D16–17.

## Branching + PR conventions

- Trunk: `main`. Integration: `feat/stellar-rewire` — every phase branch PRs here.
- Phase branch naming: `s1/<topic>` (Sprint 1), `s2/...`, etc.
- Branch from current `feat/stellar-rewire`, not main.
- Don't pre-create empty phase branches — cut a branch only when you start work.
- One PR per phase branch. Squash-merge into integration.
- Must pass `npm run lint && npm run build` before PR.
- D30 EOD: integration branch → `main` via squash merge.

## Commit + PR style

- Conventional commits with scope: `refactor(scope): ...`, `fix(scope): ...`,
  `feat(scope): ...`, `docs(scope): ...`. Scope is module name(s).
- No AI-tool references in commits, PRs, or code comments. No `Co-Authored-By`
  trailers for AI assistants. Professional engineering tone only.
- PR descriptions: brief Summary + Test plan checklist. No marketing language.

## Code style

- TypeScript strict. No `any` unless explicitly justified.
- Default to no comments. Only write a comment for non-obvious WHY (hidden
  constraint, subtle invariant, workaround for a specific bug). Don't narrate
  what the code does.
- No backwards-compatibility shims, no feature flags, no dead-code re-exports.
  Delete unused code instead of leaving it commented out.
- Errors: only handle at system boundaries (RPC calls, user input). Don't
  defensive-catch internal calls.

## Key files to know

| Concern | File |
| --- | --- |
| Ledger tick / SSE subscriber | [contexts/ledger-subscriber.tsx](contexts/ledger-subscriber.tsx) |
| RQ provider | [contexts/query-provider.tsx](contexts/query-provider.tsx) |
| Layout (Provider mounting order) | [app/layout.tsx](app/layout.tsx) |
| Earn hooks | [hooks/use-earn.ts](hooks/use-earn.ts) |
| Margin hooks | [hooks/use-margin.ts](hooks/use-margin.ts) |
| Farm hooks (Blend + Aquarius) | [hooks/use-farm.ts](hooks/use-farm.ts) |
| Soroswap hooks | [hooks/use-soroswap.ts](hooks/use-soroswap.ts) |
| Token prices (tick-driven, our pattern) | [hooks/use-token-prices.ts](hooks/use-token-prices.ts) |
| Token prices (60s poll, from sync — D12 reconcile) | [contexts/price-context.tsx](contexts/price-context.tsx) |
| XLM price fetch/cache (used by PriceProvider) | [lib/prices.ts](lib/prices.ts) |
| Swap amount math (`capAmountToMaxBalance`, stroops) | [lib/utils/swap-amount.ts](lib/utils/swap-amount.ts) |
| Margin token attribution (borrow-vs-own split) | [lib/utils/margin-token-attribution.ts](lib/utils/margin-token-attribution.ts) |
| Wallet hooks (deposit/withdraw) | [hooks/use-wallet.ts](hooks/use-wallet.ts) |
| Margin store (Zustand) | [store/margin-account-info-store.ts](store/margin-account-info-store.ts) |
| Earn pool store (Zustand, dual-write) | [store/earn-pool-store.ts](store/earn-pool-store.ts) |
| Blend store (refreshKey — being deleted in D11) | [store/blend-store.ts](store/blend-store.ts) |
| Contract service | [lib/stellar-utils.ts](lib/stellar-utils.ts) |
| Margin service | [lib/margin-utils.ts](lib/margin-utils.ts) |
| Blend service | [lib/blend-utils.ts](lib/blend-utils.ts) |
| Aquarius service | [lib/aquarius-utils.ts](lib/aquarius-utils.ts) |
| Soroswap service | [lib/soroswap-utils.ts](lib/soroswap-utils.ts) |

## Where decisions live

- Sprint plan + day-by-day work: [SPRINT_1_GUIDE.md](SPRINT_1_GUIDE.md)
- New-dev onboarding (Rohit): [ONBOARDING.md](ONBOARDING.md)
- Codebase health audit + per-issue day mapping: [CODEBASE_AUDIT.md](CODEBASE_AUDIT.md)
- Implementation details + code recipes: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- Backend choices (Mercury, Hubble): [BACKEND_OPTIONS.md](BACKEND_OPTIONS.md), [BACKEND_RESEARCH.md](BACKEND_RESEARCH.md)
- Protocol-side roadmap: [PROTOCOL_BACKEND_PLAN.md](PROTOCOL_BACKEND_PLAN.md)
- Notion source of truth for the sprint: https://www.notion.so/Sprint-1-Plan-Frontend-Rewire-2-Dev-Split-36042874c59b80e7a81fdec4d85eb0d7
