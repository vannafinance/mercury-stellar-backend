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

### WS-3 · Env-configurable + dedicated RPC — `s5/analytics-rpc-env`
Make `SOROBAN_RPC_URL` read `process.env.SOROBAN_RPC_URL` (fallback to the public node). Add retry/backoff on 429/5xx. Raise `SCAN_CONCURRENCY` when a dedicated endpoint is configured.
- **Accept:** RPC endpoint swappable via env (no code change to switch providers); with a dedicated node, no throttling and higher concurrency.
- **Note:** dedicated RPC is an *amplifier* for WS-2, not a replacement — pick a provider (Validation Cloud / QuickNode / Blockdaemon / Ankr, or self-host).

### WS-4 · Hubble for protocol-wide aggregates — **correct long-term** — `s5/analytics-hubble-aggregates`
Serve the overview KPIs (TVL, total borrowed, utilisation, account count) from **Hubble (BigQuery)** on pubnet — milliseconds, no fan-out. Keep the (now-batched) RPC scan as the **testnet** fallback, gated the same way as `/stats`.
- **Accept:** pubnet overview reads from Hubble; testnet falls back to the batched scan; values reconcile.

---

## 4. Sequencing

```
WS-0 (measure)
  └─> WS-1 (cron warm → instant relief for users)
        └─> WS-2 (getLedgerEntries batch → real fix, ~30s → <5s)
              ├─> WS-3 (dedicated RPC → reliability + headroom)
              └─> WS-4 (Hubble aggregates → correct pubnet source)
```
WS-1 ships value on day one (users stop waiting). WS-2 is the core engineering fix. WS-3/WS-4 harden and finalize.

---

## 5. Branching strategy (mirrors current flow)

- **One feature branch per workstream**, branched off `feat/stellar-rewire`:
  `s5/analytics-instrumentation`, `s5/analytics-cron-warm`, `s5/analytics-ledger-batch`, `s5/analytics-rpc-env`, `s5/analytics-hubble-aggregates`.
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
