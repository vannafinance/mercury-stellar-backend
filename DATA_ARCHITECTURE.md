# Data Architecture — RPC vs Mercury vs Hubble

> **Purpose:** the single reference for *where our on-chain data comes from and why*.
> Read this before adding a new data read, and use it to justify the design to anyone.
>
> One-line version: **we use three data layers because there are three different
> question shapes, and no single source answers all three well.**

---

## 1. The core principle

A blockchain frontend has to answer three fundamentally different kinds of question:

| Layer | Answers | Query shape | Latency | Used by (in our app) |
| --- | --- | --- | --- | --- |
| **RPC** (Soroban `simulateTransaction`) | "What does X hold **right now**?" | live state read | real-time | analytics snapshot, position/stat cards |
| **Mercury** (event indexer) | "What did **this account** do?" | point / scoped, real-time | real-time | per-user history tabs (margin/earn/farm/soroswap) |
| **Hubble** (SDF BigQuery dataset) | "What is the **whole protocol** doing over **all time**?" | analytical aggregate (SQL `GROUP BY`/`SUM`/rank) | batch (~mins) | the `/stats` page |

The mistake to avoid is thinking one of them can do it all. They can't — each is the
*wrong* tool for the other two's job, and forcing it creates the exact problems we spent
the sprint removing.

### Diagram — the three layers around our protocol

```
                  ┌──────────────────────────────────────────────────────────┐
                  │              VANNA STELLAR FRONTEND  (Next.js)             │
                  │   margin · earn · farm · portfolio · /analytics · /stats   │
                  └──────────────────────────────────────────────────────────┘
                        ▲                     ▲                       ▲
       "what does X     │     "what did       │      "what's the      │
        hold RIGHT NOW?"│   THIS ACCOUNT do?" │    WHOLE PROTOCOL      │
                        │                     │     doing over time?"  │
                ┌───────┴───────┐    ┌────────┴───────┐     ┌──────────┴───────┐
                │      RPC       │    │    MERCURY     │     │      HUBBLE      │
                │  Soroban node  │    │ event indexer  │     │   SDF BigQuery   │
                ├────────────────┤    ├────────────────┤     ├──────────────────┤
                │ live state     │    │ per-account    │     │ protocol-wide    │
                │ real-time      │    │ history,       │     │ aggregates (SQL) │
                │                │    │ real-time      │     │ batch (~mins)    │
                ├────────────────┤    ├────────────────┤     ├──────────────────┤
                │ stat cards,    │    │ history tabs   │     │ /stats page      │
                │ /analytics     │    │ (4/5 hooks;    │     │ (D23–24, new —   │
                │ snapshot       │    │ Aquarius TODO) │     │ not built yet)   │
                └───────┬────────┘    └───────┬────────┘     └────────┬─────────┘
                        │ simulate            │ indexes               │ indexes
                        │ (read state)        │ events  ┌─ timestamps │ events
                        ▼                     ▼         │ via Horizon ▼
                  ┌──────────────────────────────────────────────────────────┐
                  │           STELLAR / SOROBAN  —  OUR PROTOCOL               │
                  │   AccountManager · LendingPool{ XLM · USDC · AQ · SO }     │
                  │   (Horizon supplies event close-times Mercury lacks)       │
                  └──────────────────────────────────────────────────────────┘

   RPC    = "now"     · the only source of current balances/HF · bounded scan (D22)
   Mercury= "history" · one account's events, real-time · timestamps from Horizon
   Hubble = "totals"  · SUM/GROUP BY over ALL accounts & time · one cached SQL query
```

---

## 2. RPC — live on-chain state

**What it is:** direct read-only calls to a Soroban RPC node (`simulateTransaction` against
a funded read-source account — no signature needed). Reads the *current* contract state.

**Why we use it:** state like "this account's current collateral, debt (principal + accrued
interest), and health factor" exists **only on-chain, right now**. There is no other source
for it — an indexer stores *events*, not current balances.

**Where it lives in our app:**
- `lib/stellar-utils.ts`, `lib/margin-utils.ts` — the contract-view calls.
- `lib/analytics/stellar/allMarginAccounts.ts` — the protocol-wide account scan that feeds
  `buildAnalyticsSnapshots` → the `/analytics/*` dashboards. It now runs **server-side behind
  the shared edge-cached route `/api/analytics/accounts`** (`s-maxage 30s`, the D25 pattern), so
  the bounded fan-out runs **~once per 30s globally** instead of in every visitor's browser; the
  client only does the cheap connected-wallet self-refresh + merge. (Mercury is deliberately
  NOT used here — it indexes *events*, not the *current* balances/HF this scan needs; see §5/§7.)
- The Margin/Earn/Farm/Portfolio **stat cards** (current HF, balances, pool stats).

**What it CANNOT do:** give you history cheaply. RPC `getEvents` only retains ~7 days and
paginates slowly. And computing protocol-wide aggregates means reading *every* account —
an unbounded fan-out (see §5).

**The trap we hit:** the analytics scan read every margin account ever created, each with
`2 + tokens + farm` RPC calls, through one unbounded `Promise.all`. At scale that melts RPC.
**D22 fix:** pooled concurrency (8) + a 200-account deep-scan cap (`allMarginAccounts.ts`).

---

## 3. Mercury — per-account event history (real-time)

**What it is:** a hosted Soroban **event indexer**. It continuously indexes contract events
and lets us query them *scoped to one account*, with cursor pagination, in real time.

**Why we use it (and not RPC) for history:** the old path scraped RPC `getEvents` (capped at
~7 days and slow). Mercury gives **full on-chain history**,
server-side filtered to one account, fast — the right tool for "show me *this user's*
deposits/borrows/repays."

**Where it lives in our app:**
- Server proxy: `app/api/mercury/events/route.ts` (attaches the `MERCURY_KEY`; the JWT never
  reaches the browser). Client: `lib/mercury-client.ts` (`fetchContractEvents` + cursor loop).
- Adapters → hooks (4 of 5 migrated):
  - `lib/mercury-margin.ts` → `useMarginHistory`
  - `lib/mercury-earn.ts` → `useEarnTransactions`
  - `lib/mercury-soroswap.ts` → `useSoroswapEvents`
  - `lib/mercury-blend.ts` → `useBlendEvents`
- ⛔ `useAquariusEvents` is **still on RPC** — the Aquarius pool event carries no depositor in
  any topic or payload field, so there's no handle to scope it per-account. It needs a
  margin-side `Trader_Aquarius*` contract event first (see `MERCURY_STATUS.md`).

**Two implementation facts worth teaching:**
1. **Attribution = where the account lives in the event.** If the account is in a *topic*
   (margin/earn/blend) → Mercury filters server-side. If it's only in the *payload*
   (Soroswap `data.to`) → we fetch un-scoped and filter client-side.
2. **Timestamps come from Horizon, not Mercury.** Mercury rows have no ledger close-time and
   its GraphQL is broken on testnet, so we recover each event's time from Horizon
   (`/transactions/{hash}` → `created_at`), deduped by tx — *except* where the event payload
   already carries a `timestamp` (our LendingPool deposit/withdraw events do, so earn is pure
   Mercury). `lib/mercury-timestamps.ts` holds the shared helper.

**What it CANNOT do:** protocol-wide aggregates. Mercury returns raw, per-account events. To
compute "top-100 borrowers all-time" you'd have to pull every account's events and sum them in
the browser — i.e. re-introduce the §5 fan-out. Mercury has no `SUM`/`GROUP BY`.

---

## 4. Hubble — protocol-wide analytical aggregates

**What it is:** SDF's public **BigQuery** dataset (`crypto-stellar.crypto_stellar.history_contract_events`).
A data warehouse of *all* Stellar contract events, queried with SQL. Not a service we run.

> **⚠️ Network caveat (verified 2026-06-16):** the public Hubble dataset indexes
> **PUBNET (mainnet) ONLY** — there is no public testnet Hubble. Our protocol is on
> testnet, so Hubble has **zero** rows for our contracts today. The integration is
> built and the credentials/queries are verified, but `/stats` only populates once we
> deploy to mainnet. (Confirmed: our AccountManager = 0 rows all-time, while the table
> holds ~131M mainnet rows per 2 days.) For testnet-time protocol stats, the only
> source that indexes our contracts is **Mercury** (client-side aggregation, fine at
> testnet scale) — deliberately deferred.

**Why we use it (and not Mercury):** the `/stats` page needs protocol-wide, historical
*aggregates* — 90-day TVL, top-100 borrowers, daily volume, recent liquidations. Those are
`GROUP BY` / `SUM` / rank queries over the **entire** dataset. BigQuery does that server-side
in one query; Mercury/RPC would require reading every account (the fan-out). Free tier covers
1 TB/mo of queries, comfortably enough.

**Where it will live (D23–24, not built yet):**
- `app/stats/page.tsx` — a **new** page (distinct from `/analytics/*`).
- 4 edge API routes: `/api/analytics/{tvl,top-borrowers,volume,liquidations}`, each
  `Cache-Control: s-maxage=300, stale-while-revalidate=900`, edge runtime.
- Server credential: `GOOGLE_CREDS_JSON` (a GCP BigQuery service-account JSON).

**How it makes `/stats` fast:** the heavy SQL runs **once every ~5 min on the edge** (not per
visitor); every user gets the cached snapshot instantly (target: 4 panels in ~2s). The
alternative (RPC fan-out over all accounts) is "many seconds or infeasible" — so for that page
it's *fast vs. impossible*, not *faster than before*.

**What it does NOT do:** speed up the existing app. Hubble touches **only** the new `/stats`
page. It is **not** real-time (batch latency), so it's wrong for per-user UX, and it does
nothing for margin/earn/farm/analytics, which stay on RPC + Mercury.

---

## 5. The anti-pattern all three avoid: the all-accounts fan-out

"Compute a protocol number by reading every account from the browser" is the recurring trap:
- RPC version → hundreds of concurrent `simulateTransaction` calls (melts RPC).
- Mercury version → pull every account's events and aggregate client-side (slow, unbounded).

The fix is *picking the right layer*: live per-account state → RPC (bounded); per-account
history → Mercury (scoped); protocol-wide aggregate → Hubble (one server-side SQL query).

---

## 6. Decision rule (use this when adding a new read)

```
Need CURRENT state (balance / debt / HF)?            → RPC
Need ONE account's history (their transactions)?     → Mercury
Need a PROTOCOL-WIDE number over all accounts/time?  → Hubble
```

If a question makes you want to loop over all accounts on the client, stop — it belongs in
Hubble (aggregate) or it's the wrong question.

---

## 7. Common confusions (we hit all of these — clear them for others)

- **"Analytics uses Mercury."** No. The `/analytics/*` snapshot is **live state → RPC**
  (bounded). Mercury only feeds the per-user history tabs. (D22 reworked the *data layer* of
  `/analytics`; it did not move it to Mercury — Mercury can't serve live state.)
- **"`/stats` is the analytics page."** No. `/stats` is a **new** Hubble-backed page (D23–24);
  `/analytics/*` is the existing RPC+Mercury island (D22, done).
- **"Hubble speeds up the app."** It speeds up / enables the **`/stats`** page only. The broad
  "make every existing stat card cold-load fast" win is **D25** — a separate edge-cache layer
  (`/api/account/[addr]` + `/api/pools`, plus the full protocol-wide analytics suite
  `/api/analytics/{accounts,pool-stats,oracle,events}`) over the *live* reads, not Hubble. The
  shared edge cache means heavy reads run ~once per TTL globally rather than per visitor — the
  win is *caching*, not switching data layers. **All `/analytics/*` data now flows through these
  shared routes**, so analytics RPC load is flat regardless of how many people view it.
- **"Mercury gives timestamps."** No — Horizon does (except where the event payload carries one).

---

## 8. The whole picture, one paragraph (for teaching)

> Our app reads on-chain data through three layers, each for a different question. **RPC**
> answers "what does this account hold right now" — live state, the only source for current
> balances/HF; it backs the stat cards and the (bounded) analytics snapshot. **Mercury** is an
> event indexer that answers "what did this account do" — real-time, scoped per account; it
> backs the per-user history tabs (4 of 5 hooks; Aquarius is blocked on a contract event).
> **Hubble** is SDF's public BigQuery warehouse that answers "what is the whole protocol doing
> over all time" — `SUM`/`GROUP BY` aggregates; it backs the new `/stats` page. We keep all
> three because each is the wrong tool for the other two's job, and forcing one to do
> everything re-creates the unbounded all-accounts fan-out we deliberately removed.
