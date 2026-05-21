# Vanna Backend — Final Plan (Mercury Stack)

> The locked-in plan. Builds on [PROTOCOL_BACKEND_PLAN.md](PROTOCOL_BACKEND_PLAN.md)
> and [BACKEND_OPTIONS.md](BACKEND_OPTIONS.md). Read those for the *why*; this
> doc is the *what* and *when*.
>
> **Total duration:** 6 weeks
> **Steady-state cost:** ~$1,500–2,000/mo at 10k DAU
> **Outcome:** Production-grade backend matching Aave/Gearbox UX standards.

---

## The Final Stack

```
┌─────────────────────────────────────────────────────────────┐
│  FRONTEND (Next.js 16 + React 19 + TanStack Query)          │
│  • LedgerSubscriberProvider                                  │
│    └─ Horizon streamLedgers SSE + Soroban getEvents poll    │
│       └─ invalidateQueries on every state change            │
│  • Hooks read from /api/* edge-cached routes                │
│  • Mutations use useMutation + invalidateQueries            │
└─────────────────────────────────────────────────────────────┘
                  │                              │
                  ▼                              ▼
┌─────────────────────────────────┐   ┌─────────────────────────┐
│  EDGE CACHE LAYER (Vercel)      │   │  MERCURY (managed)      │
│  /api/snapshot   (4s s-maxage)  │   │  GraphQL endpoint       │
│  /api/account/[addr] (SWR)      │   │  12 event topics indexed│
│  /api/analytics/* (5m s-maxage) │   │  Trader history,        │
└─────────────────────────────────┘   │  Leaderboard,           │
                  │                    │  LP search              │
                  ▼                    └─────────────────────────┘
┌─────────────────────────────────┐                │
│  SOROBAN RPC (2× HA nodes)      │                │
│  Validation Cloud / Blockdaemon │                │
└─────────────────────────────────┘                │
                  │                                │
                  ▼                                ▼
┌──────────────────────────────────────────────────────────────┐
│  ON-CHAIN (Soroban testnet/mainnet)                          │
│                                                              │
│  ┌──────────────────────┐   ┌─────────────────────────────┐ │
│  │ ProtocolViewContract │   │ Existing protocol contracts │ │
│  │  (NEW — compressor)  │──▶│ Registry, AccountManager,   │ │
│  │  get_user_full_view  │   │ SmartAccount, RiskEngine,   │ │
│  │  get_protocol_snap   │   │ Oracle (Reflector wrap),    │ │
│  │  get_accounts_batch  │   │ LendingPool{XLM,USDC,EURC}, │ │
│  └──────────────────────┘   │ vTokens, TrackingToken      │ │
│                             └─────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                                  │ events emitted
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│  HISTORICAL / ANALYTICS                                      │
│                                                              │
│  • Mercury (live, ~5s lag) → trader history, leaderboard    │
│  • Stellar Hubble BigQuery (free, ~5min lag) → deep charts  │
└──────────────────────────────────────────────────────────────┘
```

---

## Sprint Roadmap (6 Weeks)

| Sprint | Duration | Owner       | Outcome                                              |
| ------ | -------- | ----------- | ---------------------------------------------------- |
| **S1** | 1 wk     | 1 FE eng    | Frontend rewired to ledger-driven invalidation       |
| **S2** | 2 wks    | 1 FE + 1 Soroban dev | Compressor contract live, dashboard 1-sim |
| **S3** | 3 days   | 1 FE eng    | Edge cache for global reads                          |
| **S4** | 1 wk     | 1 FE eng    | Mercury indexing all 12 event topics                 |
| **S5** | 3 days   | 1 FE eng    | Hubble analytics (charts, leaderboard data)          |
| **S6** | 1 wk     | 1 DevOps    | Production infra + monitoring + alerts               |

---

## Sprint 1 — Frontend Rewire (1 week)

**Goal:** Eliminate every `setInterval` and `refetchInterval`. Switch to
ledger-tick driven invalidation. Drop CoinGecko.

### Files to create

| File | Purpose |
| ---- | ------- |
| [contexts/ledger-subscriber.tsx](contexts/ledger-subscriber.tsx) | Horizon SSE + Soroban events poll → invalidate RQ keys |
| [hooks/use-oracle-prices.ts](hooks/use-oracle-prices.ts) | Reads `OracleContract.get_price_latest` directly (replaces CoinGecko) |

### Files to delete

| File | Reason |
| ---- | ------ |
| [contexts/price-context.tsx](contexts/price-context.tsx) | CoinGecko dependency dead |
| [lib/prices.ts](lib/prices.ts) | CoinGecko dependency dead |
| `setInterval` at [app/page.tsx:111](app/page.tsx#L111) | Replaced by ledger subscriber |
| `refreshKey` machinery in [store/blend-store.ts](store/blend-store.ts) | Use RQ `invalidateQueries` instead |

### Files to modify

| File | Change |
| ---- | ------ |
| [app/layout.tsx](app/layout.tsx) | Wrap app in `<LedgerSubscriberProvider>` |
| [hooks/use-earn.ts](hooks/use-earn.ts) | Remove `refetchInterval`. Mutations → `useMutation` |
| [hooks/use-farm.ts](hooks/use-farm.ts) | Same |
| [hooks/use-soroswap.ts](hooks/use-soroswap.ts) | Same |
| [hooks/use-margin.ts](hooks/use-margin.ts) | Remove 10s polling; depend on ledger tick |
| [lib/hooks/useSmartPolling.ts](lib/hooks/useSmartPolling.ts) | Delete (unused) OR keep as fallback for off-chain APIs |

### Acceptance

- [ ] Zero `setInterval` in non-animation code
- [ ] Zero `refetchInterval` in any `useQuery`
- [ ] Zero CoinGecko reference in repo
- [ ] All mutations use `useMutation` with `onSuccess: () => qc.invalidateQueries(...)`
- [ ] App boots, dashboard refreshes within 5 s of any state change

---

## Sprint 2 — ProtocolViewContract (2 weeks)

**Goal:** Collapse 8–20 simulations per page render into 1.

### Soroban contract to build

Path: `Protocol_V1_Soroban/contracts/ProtocolViewContract/`

```
ProtocolViewContract/
├── Cargo.toml
└── src/
    ├── lib.rs        # Contract entry
    ├── types.rs      # AccountView, PoolStats, ProtocolSnapshot, TokenBalanceUsd, TokenPrice
    └── view.rs       # 4 view functions
```

Public functions (full code in [PROTOCOL_BACKEND_PLAN.md §3.2](PROTOCOL_BACKEND_PLAN.md)):

```rust
pub fn get_account_view(env, margin_account: Address) -> AccountView
pub fn get_protocol_snapshot(env) -> ProtocolSnapshot
pub fn get_user_full_view(env, margin_account: Address) -> (AccountView, ProtocolSnapshot)
pub fn get_accounts_view_batch(env, accounts: Vec<Address>) -> Vec<AccountView>
```

### Frontend files to create

| File | Purpose |
| ---- | ------- |
| [lib/view-codec.ts](lib/view-codec.ts) | XDR → TS struct decoders for `AccountView`, `PoolStats`, etc. |
| [hooks/use-account-view.ts](hooks/use-account-view.ts) | RQ hook calling `get_account_view` |
| [hooks/use-protocol-snapshot.ts](hooks/use-protocol-snapshot.ts) | RQ hook calling `get_protocol_snapshot` |
| [hooks/use-user-full-view.ts](hooks/use-user-full-view.ts) | RQ hook for combined call (most pages use this) |

### Frontend files to refactor

Existing dashboard / earn / farm hooks become **selectors over `useUserFullView`**:

```ts
// Before: many separate hooks
const { data: pools } = usePoolData();
const { data: positions } = useUserPositions();
const { data: blendStats } = useBlendPoolStats();
// 8+ hooks × 8+ sims

// After: one hook, many selectors
const { data } = useUserFullView(marginAccount);
const collaterals = data?.account.collaterals;
const pools = data?.snapshot.pools;
const healthFactor = data?.account.health_factor_wad;
// 1 hook, 1 sim
```

### Deployment & testing

- [ ] Deploy `ProtocolViewContract` to testnet
- [ ] Profile resource budget on a worst-case account (5 collaterals + 3 borrows + 5 pools)
- [ ] Verify single-sim execution stays under Soroban's 100M instruction limit
- [ ] Bench: dashboard render before vs after (target: 8–10 sims → 1)
- [ ] Update `RegistryContract` to expose `get_view_contract_address()` if you want it discoverable on-chain

### Acceptance

- [ ] Dashboard makes exactly 1 `simulateTransaction` per ledger tick (not per pool/asset)
- [ ] Earn page makes exactly 1 sim
- [ ] Farm page makes exactly 1 sim
- [ ] Resource-budget profiling shows comfortable headroom (>20% of instructions remaining)
- [ ] All existing UI behavior preserved (health factor, balances, APRs match pre-refactor)

---

## Sprint 3 — Edge Cache Layer (3 days)

**Goal:** Survive 10k concurrent users on Soroban RPC by caching global reads.

### API routes to create

| Route | Cache strategy | What it serves |
| ----- | -------------- | -------------- |
| [app/api/snapshot/route.ts](app/api/snapshot/route.ts) | `s-maxage=4, stale-while-revalidate=10` | Global pool stats + prices (`get_protocol_snapshot`) |
| [app/api/account/[addr]/route.ts](app/api/account/[addr]/route.ts) | `s-maxage=3, stale-while-revalidate=8` | Per-user view (`get_account_view`) |

Both run on **Vercel Edge Runtime** (`export const runtime = "edge"`).

### Frontend hook changes

```ts
// hooks/use-protocol-snapshot.ts
export function useProtocolSnapshot() {
  const tick = useLedgerTick();
  return useQuery({
    queryKey: ["snapshot", tick],
    queryFn: () => fetch("/api/snapshot").then(r => r.json()),
    staleTime: 3_000,
  });
}
```

### Cloudflare config (if used)

- Cache rule on `/api/snapshot`: respect origin Cache-Control
- Cache rule on `/api/account/*`: bypass cache (per-user, but Vercel Edge still caches)
- Cache rule on `/api/analytics/*`: TTL 5 min

### Acceptance

- [ ] `/api/snapshot` returns 200 with `Cache-Control: s-maxage=4` header
- [ ] Hitting `/api/snapshot` 1000 times in 5 s results in **1** Soroban RPC call (rest cached)
- [ ] Per-user `/api/account/[addr]` cache key includes the address
- [ ] Load test: 1k concurrent users → fewer than 50 RPC calls/min total

---

## Sprint 4 — Mercury Indexer (1 week)

**Goal:** Live trader history, leaderboard, and event-driven analytics.

### Mercury setup

1. Sign up at [mercurydata.app](https://mercurydata.app), Pro tier ($99–400/mo)
2. Add contract addresses to index:
   - `AccountManagerContract`
   - `LendingProtocolXLM`, `LendingProtocolUSDC`, `LendingProtocolEURC`
   - `LendingProtocolAquariusUsdc`, `LendingProtocolSoroswapUsdc`
   - `SmartAccountContract` (template — Mercury auto-discovers per-user instances)
3. Configure 12 event topics:

| Topic                          | Source contract     | Mercury entity name |
| ------------------------------ | ------------------- | ------------------- |
| `Smart_account_creation`       | AccountManager      | `AccountCreated`    |
| `Smart_Account_Closed`         | AccountManager      | `AccountClosed`     |
| `Smart_Account_Activated`      | SmartAccount        | `AccountActivated`  |
| `Smart_Account_Deactivated`    | SmartAccount        | `AccountDeactivated`|
| `Trader_Borrow`                | AccountManager      | `Borrow`            |
| `Trader_Repay_Event`           | AccountManager      | `Repay`             |
| `Trader_Liquidate_Event`       | AccountManager      | `Liquidation`       |
| `Trader_SettleAccount_Event`   | AccountManager      | `Settle`            |
| `deposit_event`                | LendingPool*        | `LenderDeposit`     |
| `withdraw_event`               | LendingPool*        | `LenderWithdraw`    |
| `mint_event`                   | LendingPool*        | `VTokenMint`        |
| `burn_event`                   | LendingPool*        | `VTokenBurn`        |

### Frontend files to create

| File | Purpose |
| ---- | ------- |
| [lib/mercury-client.ts](lib/mercury-client.ts) | GraphQL client (`graphql-request` or similar) |
| [hooks/use-trader-history.ts](hooks/use-trader-history.ts) | Replaces localStorage merge in `use-margin.ts` |
| [hooks/use-leaderboard.ts](hooks/use-leaderboard.ts) | Top borrowers / top lenders queries |
| [hooks/use-pool-lenders.ts](hooks/use-pool-lenders.ts) | Replaces unbounded `get_lenders_usdc()` chain read |

### Files to modify

| File | Change |
| ---- | ------ |
| [hooks/use-margin.ts](hooks/use-margin.ts) | Replace localStorage history merge with Mercury query |

### Acceptance

- [ ] Mercury dashboard shows all 12 entities with live data
- [ ] Trader history page loads in <500 ms from Mercury
- [ ] Leaderboard top-100 query returns in <300 ms
- [ ] No more on-chain `get_lenders_usdc()` calls in frontend
- [ ] After a `Trader_Borrow` transaction, Mercury reflects the new event within 5 s

---

## Sprint 5 — Hubble Analytics (3 days)

**Goal:** Free deep analytics for charts and historical reports.

### BigQuery setup

1. Create GCP project, enable BigQuery API
2. Create service account with `BigQuery Data Viewer` + `BigQuery Job User` roles
3. Save credentials to Vercel env: `GOOGLE_APPLICATION_CREDENTIALS_JSON`
4. Use `@google-cloud/bigquery` Node client

### 4 SQL queries to ship

```sql
-- 1. Daily TVL chart (data for line chart on /stats)
SELECT DATE(closed_at) AS day,
       SUM(CAST(JSON_VALUE(data, '$.amount') AS NUMERIC)) / 1e18 AS tvl_usd
FROM `crypto-stellar.crypto_stellar.contract_events`
WHERE topic_0 IN ('deposit_event', 'withdraw_event')
  AND contract_id IN ('USDC_POOL_ADDR', 'XLM_POOL_ADDR', 'EURC_POOL_ADDR')
GROUP BY day ORDER BY day DESC LIMIT 90;

-- 2. All-time top borrowers (leaderboard supplement)
SELECT JSON_VALUE(data, '$.smart_account') AS smart_account,
       SUM(CAST(JSON_VALUE(data, '$.token_value') AS NUMERIC)) / 1e18 AS total_borrowed_usd
FROM `crypto-stellar.crypto_stellar.contract_events`
WHERE topic_0 = 'Trader_Borrow'
  AND contract_id = 'ACCOUNT_MANAGER_ADDR'
GROUP BY smart_account
ORDER BY total_borrowed_usd DESC LIMIT 100;

-- 3. Daily borrow volume (for /stats volume chart)
SELECT DATE(closed_at) AS day,
       SUM(CAST(JSON_VALUE(data, '$.token_amount') AS NUMERIC)) / 1e18 AS volume
FROM `crypto-stellar.crypto_stellar.contract_events`
WHERE topic_0 = 'Trader_Borrow'
  AND contract_id = 'ACCOUNT_MANAGER_ADDR'
GROUP BY day ORDER BY day DESC LIMIT 90;

-- 4. Liquidation feed (most recent 50 liquidations across protocol)
SELECT closed_at, JSON_VALUE(data, '$.smart_account') AS smart_account, transaction_hash
FROM `crypto-stellar.crypto_stellar.contract_events`
WHERE topic_0 = 'Trader_Liquidate_Event'
  AND contract_id = 'ACCOUNT_MANAGER_ADDR'
ORDER BY closed_at DESC LIMIT 50;
```

### API routes to create

| Route | Cache | Query |
| ----- | ----- | ----- |
| [app/api/analytics/tvl/route.ts](app/api/analytics/tvl/route.ts) | `s-maxage=300` | TVL chart |
| [app/api/analytics/top-borrowers/route.ts](app/api/analytics/top-borrowers/route.ts) | `s-maxage=600` | Top borrowers |
| [app/api/analytics/volume/route.ts](app/api/analytics/volume/route.ts) | `s-maxage=300` | Daily volume |
| [app/api/analytics/liquidations/route.ts](app/api/analytics/liquidations/route.ts) | `s-maxage=60` | Liquidation feed |

### Acceptance

- [ ] `/stats` page loads with TVL chart, volume chart, top borrowers in <2 s
- [ ] BigQuery costs $0 (well under 1TB/month free tier)
- [ ] All API routes return data with proper cache headers

---

## Sprint 6 — Production Infra (1 week)

**Goal:** Survive 10k DAU with HA, observability, and runbooks.

### Infrastructure

| Service | Provider | Spec | Cost/mo |
| ------- | -------- | ---- | ------- |
| Soroban RPC #1 | Validation Cloud / Blockdaemon | Production tier | $250–400 |
| Soroban RPC #2 (failover) | Different provider | Production tier | $250–400 |
| Horizon | Validation Cloud / self-host | Production tier | $300–500 |
| Mercury Pro | mercurydata.app | Pro / Team | $200–400 |
| Vercel | Vercel | Pro | $20 + edge usage |
| Cloudflare | Cloudflare | Pro | $20 |
| Sentry | Sentry | Team | $26 |
| Grafana Cloud | Grafana | Pro | $50–100 |
| **Total** | | | **~$1,500–2,000/mo** |

### Frontend RPC config

```ts
// lib/stellar-utils.ts
const RPC_URLS = [
  process.env.NEXT_PUBLIC_SOROBAN_RPC_PRIMARY,
  process.env.NEXT_PUBLIC_SOROBAN_RPC_FALLBACK,
];

// Round-robin or primary-with-fallback strategy
```

### Monitoring dashboards (Grafana)

- [ ] Soroban RPC: requests/sec, p50/p95/p99 latency, error rate
- [ ] Horizon: SSE connection count, ledger lag
- [ ] Mercury: indexer lag, GraphQL latency, error rate
- [ ] Vercel edge: cache hit rate per route, function latency
- [ ] Frontend Sentry: JS error rate, transaction failures

### Alerts (PagerDuty / Opsgenie / Slack)

| Condition                          | Severity |
| ---------------------------------- | -------- |
| RPC #1 down for >2 min             | High     |
| Both RPCs down                     | Critical |
| Mercury indexer lag >60 s          | Medium   |
| Horizon SSE error rate >5%         | High     |
| Edge cache hit rate <50%           | Low      |
| JS error rate >1%                  | Medium   |
| `liquidate()` tx failure           | High     |

### Runbooks to write

| Runbook | What it covers |
| ------- | -------------- |
| `RPC failover` | When primary RPC dies, how to switch |
| `Mercury outage` | Frontend graceful degradation, manual reindex |
| `Compressor redeployment` | Versioning view contract without breaking frontend |
| `Hot-fix release` | Vercel rollback, edge cache purge |

### Acceptance

- [ ] Grafana dashboards live, all panels populated
- [ ] Synthetic load test: 1k concurrent users for 30 min, no degradation
- [ ] Failover test: kill primary RPC, frontend stays up via fallback
- [ ] All alerts wired to Slack with playbook links
- [ ] On-call rotation defined

---

## Definition of Done (entire 6-week project)

- [ ] Zero `setInterval` for data fetching in repo
- [ ] Zero CoinGecko reference in repo
- [ ] One `simulateTransaction` per page render
- [ ] Edge cache absorbs 99% of repeated global reads
- [ ] Mercury indexes all 12 event types live
- [ ] Hubble powers all charts on `/stats`
- [ ] 2× RPC HA + 1× Horizon HA in production
- [ ] Grafana + Sentry + alerts live
- [ ] Load test passes 1k concurrent users
- [ ] Runbooks documented
- [ ] On-call rotation defined

---

## Cost summary

| Phase    | One-time | Monthly recurring |
| -------- | -------- | ----------------- |
| Sprint 1 | ~$2,000 (1 wk eng) | $0 |
| Sprint 2 | ~$5,000 (2 wks FE + Soroban) | small testnet RPC |
| Sprint 3 | ~$1,000 (3 days eng) | edge function usage included in Vercel |
| Sprint 4 | ~$1,500 (1 wk eng) | $200–400 (Mercury Pro) |
| Sprint 5 | ~$1,000 (3 days eng) | $0 (Hubble free tier) |
| Sprint 6 | ~$2,000 (1 wk DevOps) + infra setup | $1,200–1,600 (RPC + Horizon + monitoring) |
| **TOTAL** | **~$12,500 build** | **~$1,500–2,000/mo at 10k DAU** |

---

## After this plan ships — what comes next

The compressor + Mercury + Hubble + edge cache stack is **good to ~50k DAU**. Beyond that:

- **Add Redis per-user cache** (Upstash / Vercel KV) — collapses repeated `/api/account/[addr]` reads further
- **Add a JSON-RPC over WebSocket gateway** — only if you launch a perp / orderbook product needing <1 s latency
- **Migrate Mercury → SubQuery self-host** — only if Mercury Enterprise tier becomes >$2k/mo OR you need the OSS narrative for fundraising

None of those are needed before mainnet launch. Ship this plan first.

---

*— end of final plan —*
