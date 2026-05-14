# Vanna Backend — Combinations & Sprint Plans

> Single decision-grade reference. Pick one combination, follow its sprint plan.
> Deep reasoning lives in [BACKEND_RESEARCH.md](BACKEND_RESEARCH.md) and
> [PROTOCOL_BACKEND_PLAN.md](PROTOCOL_BACKEND_PLAN.md).

---

## The 3 layers every option must cover

Any production backend for Vanna needs an answer to three questions:

| Layer                | What it does                                         |
| -------------------- | ---------------------------------------------------- |
| **A. Reads**         | How the frontend fetches *current* on-chain state    |
| **B. Live updates**  | How the UI refreshes when state changes              |
| **C. History**       | Where charts / leaderboards / tx history come from   |

A 4th concern (only for high-scale): **Edge cache** for global reads.

---

## Options per layer

### Layer A — Reads

| Option | What it is | Effort | Cost | Best for |
| ------ | ---------- | ------ | ---- | -------- |
| **A1. Raw `Promise.all` of N sims** | What you do today | none | free | dev only |
| **A2. `ProtocolViewContract` (compressor)** | One Soroban contract bundling all reads | 2 wks | free | **default** |
| **A3. Compressor + edge-cached API route** | Compressor + `Cache-Control` on a Next.js route for global data | +3 days | ~$50/mo | 10k+ users |
| **A4. Compressor + Redis cache tier** | Per-user view cached in Redis with SWR | +1 wk | ~$50/mo | 100k+ users |

### Layer B — Live updates

| Option | What it is | Effort | Cost | Best for |
| ------ | ---------- | ------ | ---- | -------- |
| **B1. `setInterval` polling** | Status quo | none | free | testnet only |
| **B2. Horizon `streamLedgers` SSE + Soroban event poll** | Stellar SDK built-in; ledger-tick driven RQ invalidation | 1 wk | free | **default** |
| **B3. Custom WebSocket gateway** | Own JSON-RPC-over-WS service in front of RPC + indexer | 4–8 wks | $300+/mo | only if perp/orderbook product |

### Layer C — History / analytics

| Option | What it is | Effort | Cost | Lock-in |
| ------ | ---------- | ------ | ---- | ------- |
| **C1. localStorage merge** | Status quo | none | free | high (no cross-device) |
| **C2. Mercury** | Managed Soroban-native indexer, GraphQL | 1 wk | $99–500/mo | high |
| **C3. SubQuery self-host** | Open-source multi-chain indexer | 3 wks | infra ~$50/mo | none |
| **C4. Stellar-ETL → Postgres + Hasura** | SDF's official ETL pipeline + your DB + auto-GraphQL | 4 wks | infra ~$80/mo | none |
| **C5. Stellar Hubble (BigQuery)** | Free public dataset, ~5min lag | 1 day | **free** | none |
| **C6. Validation Cloud / Goldsky** | Enterprise data-as-a-service | 1 wk | $1k+/mo | medium |

---

## The 4 recommended combinations

| Name | Use case | Total time | Monthly cost (10k DAU) | Lock-in |
| ---- | -------- | ---------- | ---------------------- | ------- |
| **Combo 1 — MVP** | Hackathon / launch / <1k users | **3 weeks** | ~$50 | none |
| **Combo 2 — Production Standard** | Public mainnet, 1k–10k DAU | **6 weeks** | ~$1.5–2k | medium (Mercury) |
| **Combo 3 — Production No-Lockin** | Same scale, OSS-friendly story | **8 weeks** | ~$1.5–2k | none |
| **Combo 4 — Max Scale** | 100k+ DAU, perp/orderbook product | **14+ weeks** | ~$5k+ | varies |

---

## Combo 1 — MVP (3 weeks)

**Layers:** A2 + B2 + C5

```
Reads    → ProtocolViewContract
Live     → Horizon SSE + Soroban event poll
History  → Stellar Hubble (BigQuery, free)
```

**Why:** Cheapest, fastest, zero vendor lock-in. Hubble has 5-min lag — fine
for charts but not live state. Compressor + ledger-tick covers everything live.

### Sprint plan

| Sprint | Duration | Owner | Deliverables |
| ------ | -------- | ----- | ------------ |
| **S1 — Frontend rewire** | 1 wk | 1 FE eng | `LedgerSubscriberProvider`, kill CoinGecko, kill all `setInterval` polling, mutations → `useMutation` + `invalidateQueries`, drop `refreshKey` machinery |
| **S2 — Compressor contract** | 2 wks | 1 FE + 1 Soroban | Build `ProtocolViewContract` (`get_user_full_view`, `get_protocol_snapshot`, `get_accounts_view_batch`), deploy testnet, FE codecs, migrate Dashboard/Earn/Farm hooks |
| **S3 — Hubble analytics** | 1–2 days | 1 FE | BigQuery service account, 4 SQL queries (TVL chart, top borrowers, daily volume, user history), FE renders via Next.js API route caching results |

### Infra

- Public Soroban RPC (free testnet) or 1 paid RPC node ($150/mo) for mainnet
- Vercel Pro ($20/mo)
- BigQuery free tier (1TB queries/month)

**Total: ~$50/mo (testnet) / ~$200/mo (mainnet light load)**

---

## Combo 2 — Production Standard (6 weeks)

**Layers:** A3 + B2 + C2 + C5

```
Reads    → Compressor + edge-cached /api routes
Live     → Horizon SSE + Soroban event poll
History  → Mercury (live) + Hubble (deep analytics)
```

**Why:** Best ergonomics, fastest time-to-market for production. Mercury
gives instant GraphQL on emitted events; Hubble handles long-tail analytics.
Edge cache survives 10k DAU on Soroban RPC.

### Sprint plan

| Sprint | Duration | Owner | Deliverables |
| ------ | -------- | ----- | ------------ |
| **S1 — Frontend rewire** | 1 wk | 1 FE | Same as Combo 1 S1 |
| **S2 — Compressor contract** | 2 wks | 1 FE + 1 Soroban | Same as Combo 1 S2 |
| **S3 — Edge cache layer** | 3 days | 1 FE | `app/api/snapshot/route.ts` with `s-maxage=4`, `app/api/account/[addr]/route.ts` with SWR. Vercel edge runtime. |
| **S4 — Mercury indexer** | 1 wk | 1 FE | Sign up Mercury Pro, configure all 12 event topics from `PROTOCOL_BACKEND_PLAN.md §1.2`, `useTraderHistory` hook against Mercury GraphQL |
| **S5 — Hubble analytics** | 3 days | 1 FE | Same as Combo 1 S3 (charts) |
| **S6 — Production infra** | 1 wk | 1 DevOps | 2× hosted Soroban RPC nodes (HA), 1× Horizon instance, monitoring, alerting |

### Infra

| Item | Cost |
| ---- | ---- |
| 2× Soroban RPC (Validation Cloud / Blockdaemon HA) | $500–800 |
| 1× Horizon hosted | $300–500 |
| Mercury Pro | $200–400 |
| Vercel Pro + edge | $50–150 |
| Cloudflare CDN | $0–100 |
| **Total** | **$1,500–2,000/mo** |

---

## Combo 3 — Production No-Lockin (8 weeks)

**Layers:** A3 + B2 + C3 + C5

```
Reads    → Compressor + edge-cached /api routes
Live     → Horizon SSE + Soroban event poll
History  → SubQuery (self-hosted) + Hubble
```

**Why:** Same scale as Combo 2 but **zero vendor lock-in**. SubQuery is OSS,
you own the indexer. Better narrative for VC raise / open-source positioning.
Adds 2 weeks of ops work vs Combo 2.

### Sprint plan

| Sprint | Duration | Owner | Deliverables |
| ------ | -------- | ----- | ------------ |
| **S1 — Frontend rewire** | 1 wk | 1 FE | Same as Combo 1 S1 |
| **S2 — Compressor contract** | 2 wks | 1 FE + 1 Soroban | Same as Combo 1 S2 |
| **S3 — Edge cache layer** | 3 days | 1 FE | Same as Combo 2 S3 |
| **S4 — SubQuery project** | 2 wks | 1 BE | Define entities matching event topics, write TS handlers, deploy to managed SubQuery service or self-host on K8s, expose GraphQL endpoint |
| **S5 — Hubble analytics** | 3 days | 1 FE | Same as Combo 1 S3 |
| **S6 — Production infra** | 1 wk | 1 DevOps | Same as Combo 2 S6 + SubQuery node hosting |

### Infra

| Item | Cost |
| ---- | ---- |
| 2× Soroban RPC (HA) | $500–800 |
| 1× Horizon | $300–500 |
| SubQuery self-host (1 indexer + Postgres + GraphQL) | $100–200 |
| Vercel + edge | $50–150 |
| Cloudflare | $0–100 |
| **Total** | **$1,000–1,750/mo** |

Slightly cheaper than Combo 2 long-term; pricier upfront in eng time.

---

## Combo 4 — Max Scale (14+ weeks)

**Layers:** A4 + B3 + C4 + C5

```
Reads    → Compressor + Redis per-user cache
Live     → Custom WebSocket gateway (JSON-RPC over WS, Derive-style)
History  → Stellar-ETL → Postgres + Hasura + Hubble
```

**Why:** Only worth doing if you're adding a **sub-1-second-latency product**
(perp, orderbook, options) or expecting 100k+ DAU. Otherwise overkill.

### Sprint plan

| Sprint | Duration | Owner | Deliverables |
| ------ | -------- | ----- | ------------ |
| **S1 — Frontend rewire** | 1 wk | 1 FE | Same as Combo 1 S1 |
| **S2 — Compressor contract** | 2 wks | 1 FE + 1 Soroban | Same as Combo 1 S2 |
| **S3 — Edge + Redis cache** | 1 wk | 1 BE | Vercel KV / Upstash Redis tier, `account_view_{addr}` 4s TTL, SWR pattern |
| **S4 — Stellar-ETL pipeline** | 2 wks | 1 BE | Self-host stellar-etl, output to Postgres, Hasura on top for auto-GraphQL |
| **S5 — WebSocket gateway** | 4–6 wks | 1 BE | Rust/Go service, JSON-RPC over WS, channels: `pools.{id}.stats`, `account.{addr}.balances`, `prices.{symbol}`, EIP-712-equivalent Stellar typed-payload auth, Kafka in middle |
| **S6 — Production infra** | 1 wk | 1 DevOps | Multi-region Soroban RPC (5+ nodes), Horizon HA, WS gateway autoscale, full observability stack |

### Infra

| Item | Cost |
| ---- | ---- |
| 5× Soroban RPC geo-distributed | $1,500–2,500 |
| 2× Horizon HA | $800–1,000 |
| Postgres (managed, replicas) | $300–500 |
| Redis cluster | $100–200 |
| WS gateway instances (autoscale) | $300–600 |
| Kafka cluster | $200–400 |
| Observability (Grafana/Prometheus/Sentry) | $100–200 |
| Vercel + edge | $200–500 |
| **Total** | **$3,500–6,000/mo** |

---

## Decision flowchart

```
                ┌──────────────────────────────┐
                │ How many DAU in 12 months?    │
                └──────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │ <1k             │ 1k–10k          │ 10k–100k+
            ▼                 ▼                 ▼
        ┌─────────┐     ┌──────────────────┐    ┌──────────────┐
        │ Combo 1 │     │ OSS pitch needed?│    │ Sub-1s       │
        │ (MVP)   │     └──────────────────┘    │ latency      │
        └─────────┘            │                │ product?     │
                       ┌───────┴────────┐       └──────────────┘
                       │ no             │ yes        │
                       ▼                ▼            ▼
                  ┌──────────┐    ┌──────────┐   ┌─────────┐
                  │ Combo 2  │    │ Combo 3  │   │ Combo 4 │
                  │ (Mercury)│    │(SubQuery)│   │(WS+Redis)│
                  └──────────┘    └──────────┘   └─────────┘
```

---

## What's identical across all 4 combos (do this regardless)

These steps are non-negotiable upgrades. Every combo starts here:

1. **Delete `setInterval` polling** in `contexts/price-context.tsx:50` and `app/page.tsx:111`
2. **Delete CoinGecko** — read from `OracleContract` (already wraps Reflector)
3. **Build `LedgerSubscriberProvider`** — Horizon SSE + Soroban events
4. **Convert mutations to `useMutation`** with `invalidateQueries` on success
5. **Delete `refreshKey` Zustand machinery** — invalidation lives in RQ
6. **Pick one source of truth** — server state in RQ, UI state in Zustand
7. **Build `ProtocolViewContract`** — collapses 20 sims to 1

That's Combo 1. Combos 2/3/4 add layers on top.

---

## Recommendation

**Start with Combo 1. Upgrade to Combo 2 or 3 before mainnet launch.**

- Combo 1 in 3 weeks gets the UX to where Aave/Gearbox feel today.
- Combo 2 (Mercury) is the fastest production graduation — 3 more weeks.
- Combo 3 (SubQuery) only if open-source / no-lockin matters for fundraising.
- Combo 4 only if you're adding orderbook/perp/options.

Don't skip directly to Combo 4 — every layer builds on the previous, and you
won't know what bottlenecks matter until you've measured Combo 1/2 in
production.

---

*— end —*
