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
  - **D11 — complete.** PR #15 `s1/cleanup-refreshkey`: `store/blend-store.ts` deleted;
    all `refreshKey`/`triggerBlendRefresh` callers removed. `grep refreshKey|triggerRefresh` → empty.
  - **D12 — complete (poll killed; dual API debt remains).** PR #14 `s1/cleanup-smartpolling`:
    `lib/hooks/useSmartPolling.ts` deleted; `app/margin/page.tsx` on ledger tick;
    `contexts/price-context.tsx` 60s `setInterval` replaced with `useLedgerTick`.
    `grep setInterval contexts/` → empty. **NOT done: the dual `useTokenPrices` API was
    never collapsed** — see the "Known debt" note below.
  - **D13–15 — complete.** PR #16 `s2/test-infra-services`: vitest v4 + happy-dom + RTL,
    `vitest.config.ts`, 80 tests across 7 files in `tests/`, `npm run test` wired.
  - **D16–17 — complete.** PR #17 `s2/error-ux`: `lib/errors/normalize.ts` (6 normalize fns)
    + `hooks/use-mutation-toast.ts` (declarative loading→success→error). 11 caller files
    migrated; `components/ui/message.tsx` deleted; `useState({type,text})` removed from use-wallet.
  - **D18–19 — complete.** Optimistic updates. PR #18 `s3/optimistic-earn`:
    `onMutate/onError/onSettled` on `useSupplyLiquidity`/`useWithdrawLiquidity`
    ([hooks/use-earn.ts](hooks/use-earn.ts)). PR #19 `s3/optimistic-margin`:
    `onMutate/onError` on `repayMutation` ([components/margin/repay-loan-tab.tsx](components/margin/repay-loan-tab.tsx)).
  - **Solo-coverage note:** Sanujit (Dev A) stepped away after D10; **Rohit (Dev B) carried
    D11–D19 solo** (PRs #14–#19), including the earn/optimistic-earn work nominally in Dev A's
    lane. Sanujit resumed 2026-06-01 at D20.
  - **Next:** D20–22 — Mercury indexer integration (prereq: sign up Mercury **free dev tier**).
    Dev A lane: D20 Mercury setup/entities/GraphQL queries → D21 margin+farm event hooks
    (`useMarginHistory`, `useBlendEvents`, `useAquariusEvents`) → D22 joint analytics-island rework.
    **Also still owed:** collapse the dual `useTokenPrices` API (D12 leftover, below).
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

## Open debt — dual `useTokenPrices` API (D12 leftover, API-shape only)

D12 killed `PriceProvider`'s 60s `setInterval` (now refreshes off `useLedgerTick`)
**and** its price source has since been migrated off CoinGecko onto the on-chain
Reflector oracle (`PriceProvider` → `fetchTokenPrice("XLM")` from `lib/oracle-price.ts`;
`grep -rni coingecko` → empty). So both `useTokenPrices` now read the **same** oracle —
no more price disagreement, no CoinGecko 429s. What remains is purely the **duplicate
API shape**:

- `hooks/use-token-prices.ts` — tick-driven, our pattern (`useTokenPrices(tokens[])` → price map).
- `contexts/price-context.tsx` — `PriceProvider`, tick-driven, oracle-backed (`useTokenPrices()` → `{prices,getPrice,xlmUsd,…}`).
- **7 files still import BOTH** (the second aliased `useTokenPricesFromHook`):
  `components/earn/{acitivity-tab,details-tab,margin-managers-tab,your-positions}.tsx`,
  `components/margin/{borrow-box,collateral-box,transfer-collateral}.tsx`.

**Still to do (low-risk now):** collapse the two `useTokenPrices` into one — retire
`PriceProvider` in favour of `hooks/use-token-prices.ts` and migrate the 7 dual importers.
Until then, **do not add new `PriceProvider` consumers** — use `hooks/use-token-prices.ts`.

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
  one-shot side effect is needed. (The `contexts/price-context.tsx` 60s poll was removed
  in D12 — it now refreshes off `useLedgerTick`.)
- `isLoading: query.isLoading || query.isFetching` → drop the OR. See pattern #3 above.
- New `PriceProvider` (`@/contexts/price-context`) consumers → use the tick-driven
  `hooks/use-token-prices.ts` instead. The two still coexist (poll removed in D12 but the
  dual API isn't collapsed yet — see "Open debt" above).
- `refreshKey` reads from `useBlendStore` → the store is **deleted** (D11). `useBlendStore`
  no longer exists; don't reintroduce it.
- `useState({ type: '', text: '' })` toast patterns in mutation callers → **deleted** (D16–17).
  Use `hooks/use-mutation-toast.ts` instead.

## Mercury integration (D20+)

> **Status (2026-06-10):** D20 foundation (PR #23) + **D21 Dev A margin-history** (PR #24
> `s4/mercury-events`, branch kept) merged. `useMarginHistory` is Mercury-sourced via the
> **REST** `/api/mercury/events` proxy (NO subscription — Federico confirmed Mercury indexes
> all contracts; query `GET /rest/events/by-ledger/contracts`). **D21 Dev B:**
> `useSoroswapEvents` Mercury-sourced via `lib/mercury-soroswap.ts` (PR #28, merged) — see the
> Soroswap note below; `useEarnTransactions` Mercury-sourced via `lib/mercury-earn.ts`
> (`s4/mercury-earn-events`) — a clean per-pool, server-scoped read (the earn event payload
> carries its own `timestamp`, so NO Horizon enrichment, unlike Soroswap). The old RPC scrapers
> `ContractService.getEarnPoolEvents` + `SoroswapService.getSoroswapLpEvents` are deleted.
> **Next:** `useBlendEvents`/`useAquariusEvents` (still RPC) + act on Federico's GraphQL/close-time answer.

On-chain **history/events** come from the Mercury indexer (replaces RPC `getEvents`
scraping + per-browser localStorage history — see `lib/margin-history.ts` and the
`getEvents` calls in `lib/{blend,margin,aquarius,soroswap}-utils.ts`, capped at ~7 days
RPC retention).

- **NO subscription needed** (confirmed by Mercury team). Mercury auto-indexes all contracts;
  the old subscribe/`/event` API is deprecated, and the GraphQL `allContractEvents` table errors —
  **don't use GraphQL for events.** Use the **REST** endpoint.
- **GraphQL is broadly broken on the testnet instance (verified 2026-06-10):** not just
  `allContractEvents` — `txInfoByTxHash`, `ledgerBySequence`, and `allLedgers` all return opaque
  server errors too. Consequence: **Mercury cannot supply an event's ledger close-time** (the REST
  row has no time column, and the GraphQL `ContractEvent → txInfoByTx → ledgerByLedger.closeTime`
  join errors). Event **timestamps must come from Horizon** (`/transactions/{hash}` → `created_at`;
  full history, unlike Soroban RPC's ~days retention). See `lib/mercury-soroswap.ts`. A Retroshade
  table indexing events WITH `closeTime` is the eventual zero-external-call fix.
- **Federico's verdict (2026-06-10) — confirmed + decided:** Classic events mirror on-chain exactly;
  ledger/close-time lives one layer up (tx/ledger), so the event itself never carries it. **GraphQL is
  gone for good** (not just broken — deprecated/removed; the PostGraphile `event→tx→ledger→close_time`
  path we tried would have worked, but it's not coming back). So two valid paths: **(a)** keep the
  per-tx **Horizon** lookup (batch/dedupe by tx — what `lib/mercury-soroswap.ts` does), or **(b)**
  **Retroshade**: capture event data + `close_time` (it's in the close meta) into one table → one query,
  no extra calls. Federico recommends **Retroshade for the LP charts, scoped to the 4 LendingPool
  contracts** (same data also feeds protocol-level risk metrics — cover both at once), and **keep
  AccountManager events in Classic** for now while per-user HF/position logic is still evolving (retroshade
  it separately once that data model settles).
- **OPEN PRE-MAINNET DECISION — contract-emits-timestamp vs Retroshade:** our own contracts can just
  emit the timestamp in the event payload — the **LendingPool `deposit_event`/`withdraw_event` ALREADY do**
  (that's why `lib/mercury-earn.ts` is pure-Mercury, no Horizon). If mainnet contracts keep emitting it,
  that's a permanent zero-call solution and Retroshade isn't needed for those. **But the Soroswap pair is
  an EXTERNAL Soroswap-protocol contract — we can't make it emit our timestamp**, so Soroswap LP charts are
  stuck with Horizon-enrich OR Retroshade regardless. Settle "do mainnet contracts emit event timestamps?"
  before launch — it fixes the definitive contract interface.
- **Events endpoint (testnet):** per-account, server-side-filtered, cursor-paginated:
  `GET https://testnet.mercurydata.app/rest/events/by-contract/<contract>?topics=<encodedAccount>&limit=100&cursor=<lastId>`.
  `topics` = the account address as a base64-XDR ScVal (`xdr.ScVal.scvAddress(new Address(addr).toScAddress()).toXDR('base64')`);
  Mercury matches it in any topic column → returns ONLY that account's events. Mercury returns
  newest→oldest capped at `limit`; walk full history by passing the last event's `id` as `cursor`.
  Event row: `{ id, contract_id, topic1…topic10, data, tx }` (NO ledger/timestamp column);
  decode base64-XDR with `scValToNative`. **The topic layout is contract-specific:** for
  AccountManager `topic1`=event name, `topic2`=account, amounts i128 ÷ 1e18 (WAD). Soroswap
  differs — see the Soroswap note below. The `topics=<account>` filter only scopes server-side
  when the account is actually in a topic column (it is for AccountManager; it is NOT for the
  Soroswap pair's rich events).
- **Auth = server-side proxy.** The JWT is **never** shipped to the browser. The client calls our
  same-origin **`/api/mercury/events`** ([app/api/mercury/events/route.ts](app/api/mercury/events/route.ts))
  (`?contract=&account=&limit=&cursor=`), which encodes the account → `topics`, attaches
  `Authorization: Bearer <MERCURY_KEY>`, and forwards to the REST endpoint. Env (server-only, in
  `.env.local`, **no `NEXT_PUBLIC_`**): `MERCURY_URL`, `MERCURY_KEY`. (A separate `/api/mercury`
  GraphQL POST proxy + `mercuryQuery` exists for non-event queries.)
- **Client:** [lib/mercury-client.ts](lib/mercury-client.ts) → `fetchContractEvents({contract, account})`
  loops the `cursor` for full history + `decodeMercuryEvent()`. `lib/mercury-margin.ts`
  `getMarginHistoryFromMercury()` feeds `useMarginHistory`; `lib/mercury-soroswap.ts`
  `getSoroswapLpEventsFromMercury()` feeds `useSoroswapEvents`.
- **Soroswap LP events differ from margin (verified on testnet, pair `CDVAIOYH…`):** the pair's
  rich `deposit`/`withdraw` events carry the account in `data.to` (a payload field, NOT a topic),
  so the `topics=<account>` server-side filter does NOT match them — and `topic1`=`"SoroswapPair"`
  (namespace), `topic2`=event name, `data`={amount_0, amount_1, liquidity, …, to} (i128 ÷ 1e7,
  token_0=XLM). The topic-scopable `mint`/`burn` events don't reliably identify the user
  (`mint`→user in topic3, `burn`→pair). So `getSoroswapLpEventsFromMercury()` fetches the pair's
  events **un-scoped** and filters `data.to === account` **client-side**. Because Mercury rows have
  no timestamp, it recovers each event's time via `getTransaction` (deduped by tx — LP actions are
  sparse). This is a deliberate divergence from margin (which dropped per-event RPC); the chart in
  `app/farm/[id]/page.tsx` filters `timestamp <= 0`, so timestamps are mandatory here. Mainnet scale
  → Retroshade per-account table (restores server-side scoping).
- **Free tier:** testnet only; mainnet = $79 Builder (post-launch). Scale is fine on Classic with
  the per-account `topics` filter + cursor pagination; a Retroshade (per-account table) is the
  longer-term cleanup (also fixes the `Trader_Borrow` no-amount/timestamp contract gap — see below).
- **Debug scripts** (gitignored, read `.env.local` at runtime): `scripts/mercury-bycontract-test.mjs`
  (per-account + cursor), `mercury-decode.mjs`, `mercury-rest.mjs`, `mercury-probe.mjs`,
  `mercury-soroswap-probe.mjs` (dumps pair row shape + event vocab).

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
| Token prices (PriceProvider, now tick-driven — dual API still owed) | [contexts/price-context.tsx](contexts/price-context.tsx) |
| XLM price fetch/cache (used by PriceProvider) | [lib/prices.ts](lib/prices.ts) |
| Swap amount math (`capAmountToMaxBalance`, stroops) | [lib/utils/swap-amount.ts](lib/utils/swap-amount.ts) |
| Margin token attribution (borrow-vs-own split) | [lib/utils/margin-token-attribution.ts](lib/utils/margin-token-attribution.ts) |
| Wallet hooks (deposit/withdraw) | [hooks/use-wallet.ts](hooks/use-wallet.ts) |
| Margin store (Zustand) | [store/margin-account-info-store.ts](store/margin-account-info-store.ts) |
| Earn pool store (Zustand, dual-write) | [store/earn-pool-store.ts](store/earn-pool-store.ts) |
| Error normalization (6 Soroban normalize fns) | [lib/errors/normalize.ts](lib/errors/normalize.ts) |
| Mutation toast hook (declarative loading→success→error) | [hooks/use-mutation-toast.ts](hooks/use-mutation-toast.ts) |
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
