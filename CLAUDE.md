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
- **Phase 2 (D8–30)** — Sanujit (Dev A) + Divyansh (Dev B) parallel.
  - Starts D8 = 2026-05-26.

See [SPRINT_1_GUIDE.md](SPRINT_1_GUIDE.md) for the day-by-day plan and Phase 2
track assignments.

## Two locked patterns — match these exactly in new code

### 1. Ledger-tick driven reads (replaces all chain-data `setInterval` / `refetchInterval`)

```ts
import { useLedgerTick } from '@/contexts/ledger-subscriber';

const { tick } = useLedgerTick();
const query = useQuery({
  queryKey: ['earn', 'pools', tick],   // tick in queryKey → refetch on each ledger close (~5s)
  queryFn: ...,
  staleTime: 4_000,                    // OK to keep a short staleTime
  // refetchInterval: REMOVED
});
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

### Anti-patterns to delete on sight

- `refetchInterval: N_000` on any chain-data query → replace with `tick` in queryKey.
- `setInterval(..., 30_000)` for chain refresh → use a `useEffect` on `tick` if a
  one-shot side effect is needed.
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
| Token prices (tick-driven) | [hooks/use-token-prices.ts](hooks/use-token-prices.ts) |
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
- Implementation details + code recipes: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- Backend choices (Mercury, Hubble): [BACKEND_OPTIONS.md](BACKEND_OPTIONS.md), [BACKEND_RESEARCH.md](BACKEND_RESEARCH.md)
- Protocol-side roadmap: [PROTOCOL_BACKEND_PLAN.md](PROTOCOL_BACKEND_PLAN.md)
- Notion source of truth for the sprint: https://www.notion.so/Sprint-1-Plan-Frontend-Rewire-2-Dev-Split-36042874c59b80e7a81fdec4d85eb0d7
