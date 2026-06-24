# Sprint — Analytics Performance

**Goal:** make the analytics section load fast. Cold load **~30s → < 2s**; warm load **instant**; no user ever waits on a cold protocol-wide RPC scan.

**Owner:** Dev A (Sanujit) · **Integration branch:** `feat/stellar-rewire` · **Prefix:** `s5/analytics-*`

---

## 1. Success metrics

| Metric | Today | Target |
|---|---|---|
| Analytics data-ready (cold) | ~30s | < 2s perceived (warm cache), < 5s true cold scan |
| Analytics data-ready (warm) | varies | instant (cache hit) |
| RPC calls per protocol scan | ~600–1000 `simulateTransaction` | < 50 (batched) |
| Cache hit rate (normal traffic) | low (cold-expires) | > 95% (cron-warmed) |
| RPC endpoint | hardcoded public testnet | env-configurable + dedicated |

---

## 2. Investigation findings (grounded in code)

### 2.1 Data flow

```
Analytics pages (overview2, whales, positions, liquidations, risk-explorer)
  → hooks/use-analytics.ts
    → lib/analytics/stellar/buildSnapshots.ts  (buildAnalyticsSnapshots)
      → fetch /api/analytics/accounts            (edge-cached: s-maxage=30, SWR=120)
        → lib/analytics/stellar/allMarginAccounts.ts  (fetchAllMarginAccountSnapshots)  ← THE SCAN

Pools / oracle:
  rpcReader.ts → getAllPoolStats (30s memo) / readOracleSnapshot
Hubble (BigQuery): lib/hubble/* → /api/analytics/{tvl, volume, top-borrowers, liquidations}
  gated by STATS_ENABLED + GOOGLE_CREDS_JSON (pubnet only) — NOT used for the overview/account scan.
```

### 2.2 The scan — where the 30s lives
`lib/analytics/stellar/allMarginAccounts.ts` → `fetchAllMarginAccountSnapshots`:
- `readAllSmartAccounts(server)` — full roster from the Registry.
- per account: `readSmartAccountOwner` (1 RPC) + `readSingleAccountState` → `Promise.all` over each collateral **and** borrow token, **one `simulateTransaction` per token** (`allMarginAccounts.ts:244,282-330`).
- Bounds: `SCAN_CONCURRENCY = 8`, `MAX_DEEP_SCAN_ACCOUNTS = 200`, `ALL_ACCOUNTS_TTL_MS = 30_000` (in-memory memo).
- **Estimate:** up to 200 accounts × (~3–5 reads each) = **~600–1000 `simulateTransaction` calls**, 8 in flight at a time, on a shared public RPC → **~30s**.

### 2.3 RPC client
- `lib/stellar-utils.ts:18` → `SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'` — **hardcoded public testnet node**, no `process.env`, no retry/backoff. Every server uses `new StellarSdk.rpc.Server(SOROBAN_RPC_URL)`.

### 2.4 Top bottlenecks (ranked)
1. **Per-account-per-token `simulateTransaction` fan-out** (~600–1000 calls) — `allMarginAccounts.ts` `readSingleAccountState`. *Dominant cost.*
2. **Single hardcoded public RPC + low `SCAN_CONCURRENCY=8`** — rate-limited, shared, can't swap to a dedicated node.
3. **Cold-cache path triggers the full scan on a user request** — edge cache (30s) + server memo (30s) both cold ⇒ a visitor eats the 30s. No cron warming.
4. **Hubble unused for protocol-wide aggregates** — the correct fast source for overview KPIs on pubnet sits idle for this path.

---

## 3. Workstreams (each = one branch → PR → `feat/stellar-rewire`)

### WS-0 · Instrumentation — **do first** — `s5/analytics-instrumentation`
Add timing + RPC-call-count logging around the scan (phases: roster → owners → state reads) and a `?debug=timing` response header. We must **measure** before/after each change.
- **Accept:** cold scan wall-time and `simulateTransaction` count are observable in logs/headers.

### WS-1 · Cron-warm the cache — **quick perceived win** — `s5/analytics-cron-warm`
Add a Vercel Cron that hits `/api/analytics/accounts?force=1` (+ pools/oracle) every ~30s, plus an optional `/api/analytics/warm` endpoint that primes all analytics caches. The scan then runs on a schedule server-side; **no user triggers a cold scan**.
- **Accept:** under normal traffic the analytics pages load instantly from a warm cache; cold scans only happen on the cron, never on a request.

### WS-2 · Batch the scan with `getLedgerEntries` — **kills the latency** — `s5/analytics-ledger-batch`
Replace per-account-per-token `simulateTransaction` with batched **`getLedgerEntries`** (≤ ~200 ledger keys per call). Derive the storage keys for each account's collateral/debt and read them in a handful of calls.
- **Accept:** scan RPC calls **< 50**; true cold scan **< 5s**; output shape + values verified identical to the current simulate-based reads (diff a snapshot before/after).
- **Investigate first:** contract storage layout — key encoding, durability (persistent vs temporary), and how `simulateTransaction` currently derives each value — so the batched keys map 1:1.

### WS-3 · Env-configurable RPC — purchased endpoint as default — `s5/analytics-rpc-env`
Make `SOROBAN_RPC_URL` read `process.env.SOROBAN_RPC_URL`, and treat a **purchased/paid RPC endpoint as the default in production** (set it in Vercel env). The public node (`soroban-testnet.stellar.org`) drops to a **dev/fallback only**. Add retry/backoff on 429/5xx. Raise `SCAN_CONCURRENCY` automatically when a non-public endpoint is configured.
- **Accept:** RPC endpoint is swappable via env with **zero code change**; production points at the purchased RPC by default; public node is only the fallback when the env var is unset.
- **Decision:** we may **not buy a dedicated RPC immediately** — but the wiring lands now so switching to a purchased endpoint is a one-line env change, not a code/deploy task. A dedicated RPC is an *amplifier* for WS-2 (batching), not a replacement. Candidate providers if/when purchased: Validation Cloud / QuickNode / Blockdaemon / Ankr, or self-host.

### WS-4 · Hubble for protocol-wide aggregates — **correct long-term (MAINNET ONLY)** — `s5/analytics-hubble-aggregates`
**Hubble (BigQuery) is mainnet/pubnet only** — it indexes the public network, not testnet. So this is the production path. Serve the overview KPIs (TVL, total borrowed, utilisation, account count) from Hubble on pubnet — milliseconds, no fan-out. **Testnet always uses the (now-batched) RPC scan** as there is no Hubble data for it; gate exactly like `/stats` (`STATS_ENABLED` + Google creds).
- **Accept:** pubnet overview reads from Hubble; testnet falls back to the batched scan; values reconcile.

### WS-5 · Mercury webhooks → materialized analytics DB — **THE STRATEGIC FIX (supersedes the RPC scan)** — `s5/analytics-mercury-webhooks`
The correct long-term architecture per Mercury (Federico): stop scanning the protocol over RPC for analytics. Let **Mercury PUSH events** to us and maintain our own current-state DB; the dashboard reads our DB (ms), not the chain.

**Flow**
1. **Register** a Mercury webhook for the protocol contracts (AccountManager/Registry + pools) with optional XDR topic filters (deposit / borrow / repay / liquidate / transfer): `POST {network}.mercurydata.app/rest/webhooks/new` (JWT auth, `webhook_endpoint`, `contract_ids`). **Save the returned secret — shown once.**
2. **Endpoint** (`/api/mercury/webhook`, Next.js route): verify `X-Mercury-Signature` (HMAC-SHA256, timing-safe) + `X-Mercury-Timestamp`; parse `{ event.body.v0.{topics,data}, tx_hash }`; **idempotent** (dedupe by `tx_hash` + event index); apply the delta; return 2xx fast.
3. **Materialized state** in our DB (Vercel Postgres / Neon / Supabase): per-account positions (collateral/debt amounts per token) + protocol aggregates (TVL units, total borrowed, account count, utilisation), updated incrementally.
4. **Read path:** dashboard reads our DB and layers **live oracle prices** (cached) at read time to compute USD / HF / utilisation. Real-time via PUSH — **no polling, no RPC fan-out.**

**Why it's the real fix:** the ~30s disappears because we never scan — we already hold every account's position. It works on **testnet AND pubnet** (Mercury indexes both), unlike Hubble.

**Must-cover (or it's wrong in prod):**
- **Backfill:** bootstrap the DB once from current state (reuse WS-2's batched `getLedgerEntries`), then webhooks keep it live.
- **Reconciliation:** periodic light re-sync to catch any missed webhook AND continuous interest accrual (`b_rate` drifts with no event) — or compute debt-with-interest from the pool rate at read time.
- **Ordering/idempotency:** apply by ledger sequence; dedupe by `(tx_hash, event_index)`.
- **Security/ops:** HMAC verify every payload, store the secret as a server env var, fast 2xx (process async), monitor delivery failures/retries.

- **Accept:** dashboard reads current-state analytics from our DB in **< 200ms with zero protocol RPC scan**; positions reflect on-chain events within seconds of a webhook; a missed webhook is corrected by reconciliation within one cycle.
- **Trade-off:** adds a stateful component (webhook route + serverless Postgres + projection logic) — standard event-sourcing/CQRS; the interim WS-1/WS-2 buy time while it's built.

---

## 4. Sequencing

```
INTERIM (ship this week — make the current scan bearable)
  WS-0 (measure) ─> WS-1 (cron warm → instant relief) ─> WS-2 (getLedgerEntries batch → ~30s→<5s)

STRATEGIC (the real architecture — eliminates the scan for analytics)
  WS-5 (Mercury webhooks → own DB)   ← live current-state, testnet + pubnet, real-time push
     ↑ backfill + reconcile reuse WS-2's batched reader

COMPLEMENTARY
  WS-4 (Hubble)        → pubnet HISTORICAL/time-series aggregates (TVL over time, volume)
  WS-3 (purchased RPC) → on-demand current-state reads (single-account HF) + backfill amplifier
```
WS-1 ships value on day one. WS-2 is the interim engineering fix **and** the backfill/reconcile reader. **WS-5 is the destination** for live analytics; WS-3/WS-4 complement it.

---

## 5. Branching strategy (mirrors current flow)

- **One feature branch per workstream**, branched off `feat/stellar-rewire`:
  `s5/analytics-instrumentation`, `s5/analytics-cron-warm`, `s5/analytics-ledger-batch`, `s5/analytics-rpc-env`, `s5/analytics-hubble-aggregates`, `s5/analytics-mercury-webhooks`.
- Each branch → **PR into `feat/stellar-rewire`**. CI must be green: `tsc --noEmit`, ESLint, `vitest run` (161+). Review, then squash/merge.
- Deploy previews are limited to `main` + `feat/stellar-rewire` (Ignored Build Step), so WS branches don't pile up deployments.
- When the sprint is green on `feat/stellar-rewire`, open a **`feat/stellar-rewire` → `main` PR** (like #42), merge, and cut a release (`v0.2.0`).
- **Commit style:** Conventional Commits, no AI-tool trailers. Examples:
  `perf(analytics): batch account scan via getLedgerEntries`,
  `feat(analytics): cron-warm the protocol scan cache`,
  `chore(rpc): make Soroban RPC endpoint env-configurable`.

---

## 6. Risks & open questions
- **WS-2 storage keys:** must map the contract's collateral/debt storage keys exactly (encoding + durability) before swapping `simulateTransaction` → `getLedgerEntries`. Validate values match on a live account first.
- **Hubble (WS-4):** needs `GOOGLE_CREDS_JSON` + `STATS_ENABLED=true`; pubnet-only — testnet keeps the RPC path.
- **Dedicated RPC (WS-3):** cost + provider choice; ensure it supports `getLedgerEntries` at the needed key volume.
- **Cron (WS-1):** Vercel Hobby cron cadence limits — confirm the plan allows a ~30s/1-min schedule, or use an external scheduler hitting the warm endpoint.

---

## 7. Definition of done
- Analytics pages load instantly on warm cache and < 5s on a true cold scan.
- Protocol scan makes < 50 RPC calls.
- RPC endpoint is env-swappable; a dedicated node can be set without a code change.
- Pubnet overview KPIs come from Hubble; testnet from the batched scan.
- All gated behind green CI; merged to `main` via PR; released as `v0.2.0`.
