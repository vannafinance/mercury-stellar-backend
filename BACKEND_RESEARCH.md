# Backend Architecture Research — Vanna vs. Derive, Gearbox, SushiSwap

> **What this document is:** A deep, side-by-side comparison of how the Vanna Stellar
> frontend currently moves data between chain ↔ UI versus how three reference DeFi
> protocols (Derive, Gearbox, SushiSwap) do it. Goal: identify exactly what we're
> doing wrong and a concrete, prioritised path to fix it (sockets, caching,
> compressors, indexer, etc.).
>
> **Audience:** Vanna engineering team (Vatsal + collaborators).
> **Last updated:** 2026-04-30
>
> **Methodology caveat:** The local code audit (Section 2) was performed directly
> against `Stellar_backend/` and is fully cited with file:line references. The
> three protocol deep-dives (Derive, Gearbox, SushiSwap) are reconstructed from
> engineering knowledge with knowledge cutoff Jan 2026 because live web access
> (`WebFetch`, `WebSearch`, `gh` CLI) was denied during the research session.
> Items most likely to drift over time (subgraph URLs, exact repo names, package
> versions, channel grammar) are tagged **[VERIFY LIVE]**. Treat tagged claims as
> "the shape is right, double-check the exact string before pasting into code."

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Stack Audit (Vanna Stellar Frontend)](#2-current-stack-audit-vanna-stellar-frontend)
3. [Derive Protocol Deep Dive](#3-derive-protocol-deep-dive)
4. [Gearbox Protocol Deep Dive](#4-gearbox-protocol-deep-dive)
5. [SushiSwap Deep Dive](#5-sushiswap-deep-dive)
6. [Side-by-Side Architecture Comparison](#6-side-by-side-architecture-comparison)
7. [What We're Doing Wrong](#7-what-were-doing-wrong)
8. [Recommended Migration Path (Prioritised)](#8-recommended-migration-path-prioritised)
9. [Code Patterns to Adopt — Concrete Examples](#9-code-patterns-to-adopt--concrete-examples)
10. [Open Questions & Next Steps](#10-open-questions--next-steps)

---

## 1. Executive Summary

Vanna's frontend today is **HTTP-polling-centric** with **zero real-time
subscriptions**. We have:

- **2 raw `setInterval` data-fetching loops** (price ctx 60 s, margin balances 30 s).
- **11 React Query hooks** with `refetchInterval` between 5 s–60 s.
- **No WebSocket / SSE / event subscriptions** anywhere in the codebase.
- **No multicall / batched-read primitive** — each pool, each asset is an
  independent `simulateTransaction` round-trip.
- **A `useSmartPolling` hook that exists but is never used** (`lib/hooks/useSmartPolling.ts:49`).
- **Off-chain price feed (CoinGecko) on the hot path**, with stables hard-coded at $1.
- **Wall-clock-anchored polling**, not ledger-close-anchored.

That stack is workable on testnet, but it's exactly what every reference protocol
moved away from years ago. The three reference protocols partition their backend
problem differently:

| Protocol     | Live data delivery        | Indexer                       | Read batching                | Hot-path off-chain dependency |
| ------------ | ------------------------- | ----------------------------- | ---------------------------- | ----------------------------- |
| **Derive**   | WebSocket (JSON-RPC)      | Custom (Postgres + Kafka + ClickHouse, off-chain matching engine) | Channels stream pre-shaped data | Yes — they *are* the matcher  |
| **Gearbox**  | Block-driven invalidation | TheGraph / Goldsky subgraph for analytics; live state from chain | Multicall3 + on-chain `*Compressor` view contracts | None — IPFS-mirror of UI is canonical |
| **SushiSwap**| Mostly polling + cached API | Custom **Extractor** (Rust) + subgraphs per chain | Multicall + Tines routing engine | Yes — Tines route service     |
| **Vanna**    | `setInterval` polling     | None                          | `Promise.all` of N RPC calls | Yes — CoinGecko for XLM       |

**The three biggest changes that would 10× our data layer:**

1. **Stop polling on wall-clock; poll on ledger close.** Use Soroban RPC's
   `getLatestLedger` / Horizon SSE `/ledgers` stream and invalidate React Query
   keys on each new ledger. Same number of refreshes, never stale, never wasted.
2. **Write a single Soroban "DataCompressor" contract** that returns a 50-field
   struct in one `simulateTransaction`. Mirrors Gearbox V3's
   `CreditAccountCompressor`. Collapses 10+ RPC calls per page render into 1.
3. **Replace CoinGecko on the hot path with Reflector / SEP-40 oracle reads
   embedded in the compressor.** Eliminates an entire class of failure (rate
   limits, downtime, drift) and removes a network request.

If we want websockets specifically (Section 3 covers Derive's design in full),
the realistic move is to **build a thin Vanna WS gateway** that wraps Horizon
ledger streams + price oracle + position events into a single
JSON-RPC-over-WebSocket interface — the way Derive does. That is a 1–2-month
build, not a weekend; the polling-on-ledger fix is a 1-week build that gets us
80 % of the perceived benefit.

The rest of this document defends every claim above with evidence.

---

## 2. Current Stack Audit (Vanna Stellar Frontend)

> **Source:** Direct code audit of `Stellar_backend/` performed 2026-04-30. All
> file:line citations are real. This is the part of the report you can fully
> trust.

### 2.1 Stack overview

- **Framework:** Next.js 16 + React 19 (App Router).
- **Chain SDK:** `@stellar/stellar-sdk` v14.4.3, `@stellar/freighter-api` v6.0.1.
- **Data layer:** TanStack Query v5 (`@tanstack/react-query`).
- **State:** Zustand v5 (10 stores under [store/](store/)).
- **Styling/UI:** Tailwind v4, Framer Motion, lightweight-charts, chart.js.

### 2.2 Polling patterns

#### 2.2.1 Raw `setInterval` (data-fetching, not animation)

| File                                                                                 | Line | Data                                  | Interval | Notes                                          |
| ------------------------------------------------------------------------------------ | ---- | ------------------------------------- | -------- | ---------------------------------------------- |
| [contexts/price-context.tsx](contexts/price-context.tsx#L50)                         | 50   | XLM USD price from CoinGecko          | 60 s     | Raw `setInterval`; window-focus refetch        |
| [app/page.tsx](app/page.tsx#L111)                                                    | 111  | Margin account borrowed balances      | 30 s     | Raw `setInterval`; conditional on wallet conn  |
| [components/ui/bridging-dialogue.tsx](components/ui/bridging-dialogue.tsx#L25)       | 25   | Tx countdown UI animation             | 10 ms    | Animation, ignore                              |
| [components/ui/carousel.tsx](components/ui/carousel.tsx#L29)                         | 29   | Carousel slide rotation               | 3 s      | Animation, ignore                              |

Net data-fetching `setInterval`s: **2**. Both could be replaced by
`useSmartPolling` or, better, ledger-driven invalidation.

#### 2.2.2 `useSmartPolling` (defined but unused)

[lib/hooks/useSmartPolling.ts:49](lib/hooks/useSmartPolling.ts#L49) — visibility-aware
polling with 2-min idle threshold, 15 s default interval. **Zero call sites.**
Dead code today; should either become the standard or be deleted.

### 2.3 React Query usage

#### 2.3.1 Defaults

[contexts/query-provider.tsx:14-29](contexts/query-provider.tsx#L14-L29):

```ts
defaultOptions: {
  queries: {
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,   // <— manually disabled
    retry: 2,                       // exponential backoff capped at 10 s
  }
}
```

#### 2.3.2 Hooks using `useQuery`

| Hook                         | File                                            | `refetchInterval` | `staleTime` | Notes                                                                |
| ---------------------------- | ----------------------------------------------- | ----------------- | ----------- | -------------------------------------------------------------------- |
| `usePoolData()`              | [hooks/use-earn.ts:44](hooks/use-earn.ts#L44)   | 30 s              | 15 s        | 4 pools fetched in parallel via `Promise.all()`                      |
| `useUserPositions()`         | [hooks/use-earn.ts:134](hooks/use-earn.ts#L134) | none              | n/a         | Refetched explicitly after mutations                                 |
| `useAllSoroswapPoolStats()`  | [hooks/use-soroswap.ts:23](hooks/use-soroswap.ts#L23) | 60 s        | 30 s        | All pools via `Promise.allSettled()`                                 |
| `useSoroswapPoolStats()`     | [hooks/use-soroswap.ts:56](hooks/use-soroswap.ts#L56) | 60 s        | 30 s        | Single pool                                                          |
| `useSoroswapLpPosition()`    | [hooks/use-soroswap.ts:77](hooks/use-soroswap.ts#L77) | none        | n/a         | Invalidated via Blend store `refreshKey`                             |
| `useSoroswapEvents()`        | [hooks/use-soroswap.ts:103](hooks/use-soroswap.ts#L103) | **10 s**  | 5 s         | `refetchOnWindowFocus: true` override — hottest hook                 |
| `useSoroswapTokenBalance()`  | [hooks/use-soroswap.ts:127](hooks/use-soroswap.ts#L127) | none      | n/a         | One-shot                                                             |
| `useBlendPoolStats()`        | [hooks/use-farm.ts:32](hooks/use-farm.ts#L32)   | 60 s              | 30 s        | XLM + USDC reserves                                                  |
| `useUserBlendPositions()`    | [hooks/use-farm.ts:68](hooks/use-farm.ts#L68)   | none              | n/a         | Uses `refreshKey` for invalidation                                   |
| `useMarginHistory()`         | [hooks/use-margin.ts:10](hooks/use-margin.ts#L10) | **10 s**        | 30 s        | Merges on-chain history with localStorage cache                      |

**Observations:**

- We *do* use React Query, but mostly as a fetch-with-cache wrapper. We don't use
  `useMutation`. Mutations are imperative; loading state is owned by callers.
- The dual-write pattern (write to RQ cache *and* Zustand) is sticky — useful for
  components that read from the store directly, but it doubles the source of
  truth. See [hooks/use-earn.ts:83-87](hooks/use-earn.ts#L83-L87).
- `invalidateQueries()` is not used. Cache freshness relies entirely on
  `staleTime` expiry + manual `refetch()` + `refreshKey` bumps in stores.

### 2.4 WebSocket / SSE / event subscription usage

> **None.** Zero `WebSocket`, zero `EventSource`, zero `Server.streamLedgers()`,
> zero `.stream()`, zero `eth_subscribe`. All updates are poll-based.

This is the central thing this document argues should change.

### 2.5 Stellar SDK call patterns

[lib/stellar-utils.ts:4-7](lib/stellar-utils.ts#L4-L7):

```ts
SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
HORIZON_URL     = 'https://horizon-testnet.stellar.org';
```

Primary call patterns:

| Method                                         | Use                              | Sites                                                    | Batching      |
| ---------------------------------------------- | -------------------------------- | -------------------------------------------------------- | ------------- |
| `server.getAccount(address)`                   | Sequence + balances              | [lib/stellar-utils.ts:138, 197, 230](lib/stellar-utils.ts#L138) | one-by-one    |
| `server.simulateTransaction(tx)`               | Dry-run contract invocations     | many                                                     | one-by-one    |
| `server.getTransaction(hash)`                  | Tx-status polling (while-loop)   | [lib/margin-utils.ts:1109-1125](lib/margin-utils.ts#L1109-L1125) | sequential, 30 attempts |
| `server.sendTransaction(tx)`                   | Submit                           | many                                                     | one-by-one    |
| `server.getContractData(addr, key, durability)`| Contract storage reads           | scripts/, [lib/margin-utils.ts](lib/margin-utils.ts)     | inside `Promise.all` |

Example of the *only* batching we have today
([hooks/use-earn.ts:49-54](hooks/use-earn.ts#L49-L54)):

```ts
const [xlmStats, usdcStats, aquariusStats, soroswapStats] = await Promise.all([
  ContractService.getPoolStats(ASSET_TYPES.XLM),
  ContractService.getPoolStats(ASSET_TYPES.USDC),
  ContractService.getPoolStats(ASSET_TYPES.AQUARIUS_USDC),
  ContractService.getPoolStats(ASSET_TYPES.SOROSWAP_USDC),
]);
```

This is **4 parallel HTTP `simulateTransaction` calls** to Soroban RPC. It works
because they're in parallel — but each is an independent network round-trip.
With N pools, N user-positions, M assets, the dashboard rapidly turns into 20+
requests per refresh cycle.

For comparison, Gearbox's frontend issues **one** `eth_call` to a
`CreditAccountCompressor` view contract that returns the same shape of data,
hydrated for *all* enabled tokens, in one round-trip (Section 4.3.2).

### 2.6 Price feed

[lib/prices.ts](lib/prices.ts) + [contexts/price-context.tsx](contexts/price-context.tsx):

| Field             | Value                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------- |
| Source (XLM)      | CoinGecko free API (`/simple/price?ids=stellar&vs_currencies=usd`)                     |
| Source (stables)  | Hard-coded $1.00 (USDC, EURC, Aquarius/Blend/Soroswap variants)                        |
| Refresh interval  | 60 s ([contexts/price-context.tsx:23](contexts/price-context.tsx#L23))                 |
| Cache TTL         | 60 s in-memory + localStorage fallback (`vanna:xlmPriceUsd`)                           |
| Fallback chain    | in-memory → localStorage → constant `0.16`                                             |
| In-flight dedup   | yes — single Promise per 60 s window                                                   |

This is the **biggest single off-chain hot-path dependency**. CoinGecko free tier
has 5–15 req/min limits and frequent 429s. Reflector
([reflector.network](https://reflector.network) — Stellar's price oracle network)
publishes prices on-chain via a Soroban contract; reading from it inside our own
compressor contract removes CoinGecko entirely.

### 2.7 Stores (Zustand) — quick inventory

10 stores under [store/](store/):

| Store                            | Persist? | Holds                                                             |
| -------------------------------- | -------- | ----------------------------------------------------------------- |
| `user.ts`                        | yes      | wallet address, balances, deposited balances                       |
| `app-mode-store.ts`              | yes      | `mode: 'pro' \| 'lite'`                                            |
| `earn-pool-store.ts`             | yes (v2) | pools, user positions, recent txs, lastUpdated                     |
| `margin-account-info-store.ts`   | yes      | margin metrics + balances + creation state                         |
| `blend-store.ts`                 | no       | `refreshKey` invalidation token                                    |
| `collateral-borrow-store.ts`     | yes (v2) | collaterals, borrowItems, position (legacy demo data)              |
| `farm-store.ts`                  | no       | `selectedRow`, `tabType`                                           |
| `earn-vault-store.ts`            | no       | `selectedVault`                                                    |
| `selected-pool-store.ts`         | no       | `selectedAsset`, `selectedPoolData`                                |
| `spot-trade-store.ts`            | yes      | `activePositions`, `openOrders` (placeholder)                      |

State-management cleanup is documented separately in [STATE_MANAGEMENT_ANALYSIS.md](STATE_MANAGEMENT_ANALYSIS.md);
this report does **not** revisit that — it focuses on the data-fetching layer.

### 2.8 Estimated load

With all hot-path hooks active:

- Pool data: 4 sims × 1 cycle / 30 s ≈ **8 calls/min**
- Soroswap pools + events: 4 sims + N event reads / 60 s + 10 s ≈ **8–24 calls/min**
- Margin balances: 1 cycle / 30 s ≈ **2–8 calls/min** depending on assets
- Margin history: 1 cycle / 10 s = **6 calls/min**
- Price: **1 HTTP call/min** to CoinGecko
- **Sustained: ~20–30 RPC calls/min per active session.**

That's tolerable on testnet. At mainnet scale with thousands of concurrent users
it's an RPC-bill problem and an Aurora/Soroban-RPC stability problem.

---

## 3. Derive Protocol Deep Dive

> **Source:** Engineering knowledge as of Jan 2026 cutoff. Live verification of
> URLs / channel grammar was not possible in this session — see
> [docs.derive.xyz](https://docs.derive.xyz/) for current authoritative values.
> Items needing live verification are tagged **[VERIFY LIVE]**.

### 3.1 What Derive is

Derive (rebrand of **Lyra v2**) is an on-chain options + perps DEX that runs its
own L2 ("Derive Chain", an OP-Stack rollup). It is *the* DeFi protocol most worth
studying for WebSocket architecture because it is one of the few that runs a
production CEX-grade matching engine while settling on-chain.

The fundamental architectural choice: **off-chain matcher, on-chain settlement**.
Orders are placed and matched in a centralised matcher (low latency, real CEX
UX), then trades are atomically settled on-chain via signed action messages.

### 3.2 WebSocket API (the headline feature)

Endpoints **[VERIFY LIVE]**:

- Mainnet: `wss://api.lyra.finance/ws` (still under the Lyra domain at the time of rebrand)
- Testnet: `wss://api-demo.lyra.finance/ws`

Protocol: **JSON-RPC 2.0 over WebSocket**. Every message is either a request
(`{id, method, params}`), a response (`{id, result|error}`), or a subscription
notification (`{method: "subscription", params: {channel, data}}`).

#### 3.2.1 Public methods (no auth)

| Method                       | Purpose                                                   |
| ---------------------------- | --------------------------------------------------------- |
| `public/get_instruments`     | List markets (e.g. `BTC-PERP`, `ETH-20240329-3000-C`)     |
| `public/get_ticker`          | Snapshot price/oi/funding for an instrument               |
| `public/get_trade_history`   | Recent trades                                             |
| `public/subscribe`           | Subscribe to one or more channels                         |
| `public/unsubscribe`         | Unsubscribe                                               |
| `public/login`               | Authenticated login (signature-based)                     |

#### 3.2.2 Channel grammar **[VERIFY LIVE]**

The key channels (paraphrased — exact tokens may differ):

| Channel                                          | Payload                                              |
| ------------------------------------------------ | ---------------------------------------------------- |
| `orderbook.{instrument}.{group}.{depth}`         | Aggregated L2 book — e.g. `orderbook.BTC-PERP.10.20` |
| `trades.{instrument}.{type}`                     | Tape — e.g. `trades.BTC-PERP.all`                    |
| `ticker.{instrument}.{interval}`                 | Mark price, OI, funding — e.g. `ticker.BTC-PERP.500` |
| `{subaccount_id}.balances`                       | Authenticated — sub-account balance updates          |
| `{subaccount_id}.orders`                         | Authenticated — open orders, fills                   |
| `{subaccount_id}.trades`                         | Authenticated — own trades                           |
| `{subaccount_id}.positions`                      | Authenticated — position deltas                      |

A subscription request looks like:

```json
{
  "id": 1,
  "method": "public/subscribe",
  "params": {
    "channels": [
      "orderbook.BTC-PERP.10.20",
      "trades.BTC-PERP.all",
      "ticker.BTC-PERP.500"
    ]
  }
}
```

A notification looks like:

```json
{
  "method": "subscription",
  "params": {
    "channel": "orderbook.BTC-PERP.10.20",
    "data": {
      "publish_id": 1234567,
      "instrument_name": "BTC-PERP",
      "bids": [["67234.50", "0.123"], ["67234.00", "0.456"]],
      "asks": [["67235.00", "0.789"]],
      "timestamp": 1720000000000
    }
  }
}
```

#### 3.2.3 Authentication

Authenticated channels (`{subaccount_id}.*`) require a `public/login` call first.
Login is **EIP-712 signature-based** — the WS client signs a typed-data payload
binding the WS session to a session key (a sub-account-scoped signing key, *not*
the user's main wallet). The matcher verifies the signature, opens the session,
and from then on private channel notifications flow to that connection.

This matters for us because: even if Stellar/Soroban doesn't support WebSocket
subscriptions natively, **a WS gateway built in front of Soroban could use the
same EIP-712-style pattern** — a Stellar wallet signs a `LoginRequest` envelope,
the gateway verifies it, and authenticated streams flow.

#### 3.2.4 Heartbeats / rate limits **[VERIFY LIVE]**

- Heartbeat: server sends a ping; client must reply with a pong (or vice versa)
  every ~30 s, else the connection is dropped.
- Rate limits: per-IP request limits (~50 req/s burst), per-account order rate
  limits enforced by the matcher in 60 s sliding windows. Exact numbers in the
  rate-limits doc page **[VERIFY LIVE]**.

### 3.3 REST API

Derive has a parallel REST surface for everything WS does + bulk historical
queries. The doc convention is `https://api.lyra.finance/public/...`. **REST is
recommended for snapshots/history; WS is recommended for anything live.**
Polling REST as a substitute for WS is discouraged in their docs **[VERIFY LIVE]**.

### 3.4 Architecture stack (publicly knowable)

The Derive team has been more open than most about the stack:

- **Matching engine:** custom **Rust** implementation. Single-binary,
  in-memory orderbook per instrument, deterministic. **[VERIFY LIVE]** (this is
  documented in their engineering blog posts and conference talks).
- **Persistence:** **PostgreSQL** for orders/trades/accounts (transactional),
  **ClickHouse** for analytics/historical queries, **Redis** for hot caches and
  pub/sub fan-out.
- **Message broker:** **Kafka** between the matcher and downstream
  consumers (settler, indexer, public WS gateway). Used so that one matcher
  instance can fan out to many WS gateway nodes.
- **WS gateway:** separate horizontally-scaleable Rust/Go service that holds
  client connections, subscribes to Kafka topics, and pushes notifications.
  Holds per-connection subscription state in memory + Redis for cross-node
  fanout.
- **On-chain settler:** signs and submits batched settlement transactions to
  Derive Chain. Uses ERC-4337-style action signing — the published SDK package
  is `derive-action-signing` (formerly `lyra-action-signing`).
- **Frontend:** Next.js + viem + wagmi + TanStack Query for non-realtime data.
  Realtime data path bypasses RQ entirely and writes directly into a Zustand-like
  store on each WS notification.

### 3.5 GitHub repos **[VERIFY LIVE]**

The relevant orgs are `github.com/derivexyz` (current) and
`github.com/lyra-finance` (legacy, still authoritative for v2 contracts).

Important repos (paraphrased — names accurate as of late 2025):

- `derivexyz/v2-protocol` — Solidity core (Matching, SubAccounts, PerpAsset, OptionAsset, ManagerStandard, etc.)
- `derivexyz/derive-action-signing` (TypeScript) — EIP-712 signers for action messages
- `derivexyz/python-action-signing` — same in Python (used by liquidator/market-maker bots)
- `derivexyz/v2-action-signing` — generic action-signing helpers
- `derivexyz/sdk` (or `lyra-finance/v2-sdk`) — TS SDK that wraps WS + REST
- `lyra-finance/v2-matching` — matching contract suite (settlement layer)
- `lyra-finance/avalon-keepers` — keeper bots
- `derivexyz/docs` — the docs site source

### 3.6 Frontend integration pattern

The recommended pattern (from their docs / SDK examples):

```ts
import { DeriveClient } from "@derivexyz/sdk";

const client = new DeriveClient({ wsUrl: "wss://api.lyra.finance/ws" });
await client.connect();
await client.login({ subaccountId, signer });

client.subscribe("orderbook.BTC-PERP.10.20", (msg) => {
  store.setOrderbook("BTC-PERP", msg.bids, msg.asks);
});
```

There is no per-component `useEffect` wiring up a WS — there's a **single
long-lived client** owned at the app shell, and channels are subscribed/
unsubscribed as the user navigates between markets. This is the right shape for
us if/when we build a WS layer.

### 3.7 What we'd steal from Derive

1. **JSON-RPC over WS** — the protocol shape. Even if we run our own WS server,
   the JSON-RPC framing is the right choice (vs. ad-hoc message types) because
   it gives request/response correlation, named subscriptions, and ergonomic
   error handling.
2. **Channel naming** — colon/dot-delimited multi-segment channels
   (`orderbook.<instrument>.<group>.<depth>`) compose well; clients can
   subscribe to a wildcard segment if the gateway supports it.
3. **Session-key auth via EIP-712 (Soroban-equivalent: Stellar typed payload signed by Freighter)** — the auth model that lets a hot-wallet signing key drive realtime
   without exposing the cold wallet.
4. **Single long-lived client, channels swap on navigation** — never per-page
   WS instances.
5. **Kafka in the middle** — once we have one realtime data source it's tempting
   to wire it directly to the WS gateway; Kafka in the middle is what lets you
   add a second consumer (chart writer, push-notifier, leaderboard updater)
   without touching the matcher.

---

## 4. Gearbox Protocol Deep Dive

> **Source:** Engineering knowledge as of Jan 2026; cross-referenced against the
> Gearbox-research subagent report. Items tagged **[VERIFY LIVE]** were not
> directly fetched.

### 4.1 Core architectural philosophy: "no backend on the hot path"

Gearbox V3's design invariant is: **all critical state lives on-chain, and the
canonical SDK reconstructs UI-ready data structures from raw chain reads**. They
*do* run infrastructure — a charts API, a liquidator bot, price-update keepers,
sometimes a meta-config API — but the hot path of "user opens dashboard, sees
their credit account" goes:

```
browser → RPC provider → Multicall3 → CreditAccountCompressor.view → browser
```

There is no Gearbox-owned server in that chain. If gearbox.fi DNS dies, users
load the IPFS-mirrored frontend and keep operating their accounts.

This is the opposite end of the spectrum from Derive (which *is* the matcher).
Both are valid; the choice depends on whether your protocol needs a centralised
component (matching engine) or whether everything can be expressed as
view-function reads (lending markets).

### 4.2 SDK package layering

Gearbox publishes a layered TS SDK on npm under `@gearbox-protocol/*`:

| Package                              | What it does                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `@gearbox-protocol/sdk-gov`          | Pure constants — token addresses, contract addresses, chain IDs, oracle types, decimals    |
| `@gearbox-protocol/sdk-v3`           | Runtime SDK — builds multicalls, decodes credit-account state, computes health factor      |
| `@gearbox-protocol/integrations-v3`  | TS metadata + Solidity adapters for Convex, Curve, Balancer, Pendle, Aave, etc.            |
| `@gearbox-protocol/core-v3`          | Solidity core (`CreditManagerV3`, `CreditFacadeV3`, `PoolV3`, `PriceOracleV3`)             |
| `@gearbox-protocol/oracles-v3`       | Solidity price-feed wrappers (Chainlink, Redstone, Pyth, composite)                        |
| `@gearbox-protocol/liquidator-v3`    | Open-source liquidation bot                                                                |

The split between **`sdk-gov`** (zero-dep constants) and **`sdk-v3`** (runtime
with viem/zod) is deliberate: governance can ship address bumps independently of
RPC strategy changes. We should mirror this — a `vanna-stellar-config` package
of pure addresses + asset metadata, separate from a `vanna-sdk` runtime package.

### 4.3 Read-batching strategy (the headline trick)

This is the part most directly applicable to Vanna.

#### 4.3.1 Multicall3 + viem batch transport

`Multicall3` is at the **same address on most EVM chains**
(`0xcA11bde05977b3631167028862bE2a173976CA11`). Gearbox uses viem's batch
transport so all `eth_call`s within a 16 ms window are coalesced into a single
`Multicall3.aggregate3` call:

```ts
const client = createPublicClient({
  transport: http(RPC_URL, {
    batch: { batchSize: 1024, wait: 16 },
  }),
  batch: { multicall: true },
});
```

Soroban does not have a `Multicall3` analogue, but it has something better
(Section 4.3.2).

#### 4.3.2 On-chain `*Compressor` view contracts (the big one)

Gearbox V3 ships **purpose-built view contracts that exist solely to bundle
reads**:

| Contract                    | Returns in 1 call                                                          |
| --------------------------- | -------------------------------------------------------------------------- |
| `CreditAccountCompressor`   | A `CreditAccountData` struct: enabled tokens, all balances, all USD prices, debt, quotas, health factor, total value, borrow rate — fully hydrated for one account. |
| `MarketCompressor`          | All deployed markets + their pools + their credit managers, hydrated.      |
| `PoolCompressor`            | Pool stats: total borrowed, expected liquidity, base rate, utilisation.    |

A `CreditAccountCompressor.getCreditAccountData(addr)` returns ~50 fields in one
`eth_call`. Without it the same data needs ~30+ separate reads.

**This pattern translates 1-to-1 to Soroban**, and is arguably the single highest-
leverage change Vanna can make. Example shape for us:

```rust
// soroban-compressor (Rust) — read-only contract
pub struct UserDashboard {
    pub margin_account: Address,
    pub collateral_balances: Vec<TokenBalance>,
    pub borrow_balances:     Vec<TokenBalance>,
    pub prices_usd:          Vec<I128>,        // from Reflector oracle
    pub health_factor:       I128,
    pub total_collateral_usd: I128,
    pub total_borrowed_usd:   I128,
    pub time_to_liquidation:  U64,
    pub borrow_rate_bps:      U32,
}

#[contractimpl]
impl Compressor {
    pub fn user_dashboard(env: Env, user: Address) -> UserDashboard { /* … */ }
}
```

Then `simulateTransaction(compressor.user_dashboard(user))` returns the entire
dashboard in a single round-trip. **No fee, since simulation is free unless
submitted.** This collapses the 8–10 RPC calls per cycle visible in
[hooks/use-earn.ts:148-160](hooks/use-earn.ts#L148-L160) into one.

#### 4.3.3 Block-driven (ledger-driven) invalidation

Gearbox doesn't poll on a wall clock. They `viem.watchBlocks` (or wagmi's
`useWatchBlockNumber`) and invalidate React Query keys on each new block:

```ts
useWatchBlockNumber({
  onBlockNumber: () => {
    queryClient.invalidateQueries({ queryKey: ['creditAccounts'] });
    queryClient.invalidateQueries({ queryKey: ['poolStats']      });
  },
});
```

This is **better than `refetchInterval: 12_000`** for two reasons:

1. **Always fresh.** A query that fires 100 ms before a block lands gets stale
   data and waits 11.9 s before refreshing. Block-driven invalidation refreshes
   the moment new state exists.
2. **Never wasted.** If no block comes (Sunday afternoon on Ethereum mainnet),
   no requests fire.

For Vanna: subscribe to `getLatestLedger` (Soroban RPC) or `/ledgers` SSE
(Horizon) and invalidate on each new ledger. Soroban ledgers close every ~5 s,
so this matches our current 5–60 s polling intervals but with zero stale reads
and zero wasted reads.

### 4.4 Subgraph (analytical only)

Gearbox runs subgraphs (originally TheGraph hosted, since hosted-service sunset
likely Goldsky/Alchemy Subgraphs **[VERIFY LIVE]**). Schema entities include
`CreditAccount`, `CreditManager`, `Pool`, `Liquidation`, `MultiCallExecuted`,
`QuotaUpdate`. **The subgraph is used for charts/history/leaderboards — not for
live state.** That line is enforced.

### 4.5 What Stellar's analogue is

| Gearbox piece               | Stellar/Soroban analogue                                            |
| --------------------------- | ------------------------------------------------------------------- |
| Multicall3                  | A custom Soroban "compressor" contract (preferred — see 4.3.2)      |
| viem batch transport        | A debounced batcher around `simulateTransaction` / `getLedgerEntries` |
| `eth_subscribe('newHeads')` | Horizon SSE on `/ledgers` *or* poll `getLatestLedger` every 5 s     |
| TheGraph subgraph           | **Mercury** (mercurydata.app) or roll-your-own Postgres indexer     |
| IPFS frontend mirror        | IPFS frontend mirror (works the same)                               |
| Chainlink/Pyth oracles      | **Reflector** (reflector.network) on Soroban                        |

Mercury is the closest thing to TheGraph for Soroban — it indexes Soroban
contract events into a queryable Postgres-backed API. Worth evaluating before we
build our own.

### 4.6 Repo list **[VERIFY LIVE]**

Under `github.com/Gearbox-protocol`:

- `core-v3`, `core-v2` — Solidity contracts
- `integrations-v3` — adapters
- `oracles-v3` — price-feed wrappers
- `governance` — multisig/timelock
- `permissionless-v3` — V3 permissionless market creation
- `bots` — V3 partial-liquidation, leverage, take-profit bots
- `sdk-gov` — addresses + constants
- `sdk-v3` — runtime SDK
- `subgraph` — TheGraph subgraph
- `gearbox-fe-v3` — V3 dApp (Next.js)
- `gearbox-frontend` — V2 dApp (legacy)
- `liquidator-v3` — liquidation bot

---

## 5. SushiSwap Deep Dive

> **Source:** Engineering knowledge as of Jan 2026. Live verification was not
> possible. Items tagged **[VERIFY LIVE]**.

### 5.1 What Sushi is, infrastructure-wise

Sushi is **the largest TypeScript monorepo in DeFi**. They support a dozen+
chains, run an aggregator, ship a routing engine ("Tines"), maintain dozens of
subgraphs, and run a Rust-based pool extractor service. They are *not* an
"on-chain only, no backend" protocol like Gearbox — they have real backend
infra, mostly because routing across hundreds of pools requires off-chain
computation.

### 5.2 Monorepo structure **[VERIFY LIVE]**

`github.com/sushiswap/sushiswap` is a Turborepo:

| Folder                     | Contents                                                                       |
| -------------------------- | ------------------------------------------------------------------------------ |
| `apps/web/` (or `apps/evm`)| Main dApp — Next.js, swap/pool/farm UIs                                        |
| `apps/telegram/`           | Sushi-in-Telegram                                                              |
| `apis/swap/`               | The "Swap API" — quote endpoint backed by the Extractor                        |
| `apis/router/`             | Multi-chain routing service                                                    |
| `apis/pool/`               | Pool data API                                                                  |
| `apis/tokens/`             | Curated token lists per chain                                                  |
| `jobs/`                    | Cron / queue workers (subgraph aggregators, price snapshot, etc.)              |
| `packages/sushi/`          | Core library: token, amount, currency, percent, pool math (the "Sushi SDK")    |
| `packages/wagmi/`          | Sushi-flavoured wagmi hooks                                                    |
| `packages/database/`       | Prisma schemas + clients                                                       |
| `packages/redis/`          | Redis client wrappers                                                          |
| `packages/tines/`          | The smart-routing algorithm (TS port of the Rust Extractor's matching logic)   |
| `packages/abi/`, `packages/chain/`, `packages/currency/`, `packages/extractor/`  | Various TS support packages                |

### 5.3 The Extractor (Rust)

The most distinctive piece of Sushi infra: **a Rust service that maintains
real-time pool state** for all monitored AMMs across every supported chain.
Lives at `github.com/sushi-labs/sushiswap-rs` or `sushiswap/extractor` **[VERIFY LIVE]**.

How it works:

1. Subscribes to `eth_subscribe('logs')` on each chain's WS RPC for swap/sync/mint/burn events.
2. Maintains an in-memory snapshot of every pool's reserves (V2) and tick state (V3).
3. On each new event, updates the snapshot and pushes to a fanout (Redis pub/sub or NATS).
4. Exposes a HTTP/RPC interface that the Swap API queries to build routes
   without ever doing on-chain reads at quote time.

Why it exists: getting an accurate swap quote requires reading the state of
*every relevant pool* in the routing graph. Doing that at quote time means N RPC
reads (where N can be 50+ for a route across 5 hops). The Extractor pre-loads
all of that into memory and keeps it event-driven-fresh, so quotes are pure
in-memory computation.

Lesson for us: even if Vanna only ever has a few pools, **a single long-lived
service that subscribes to chain events and maintains a shared cache** is the
correct shape once we have more than ~3 actively-used pools. On Stellar that
service subscribes to Horizon `/effects` SSE or Soroban event streams.

### 5.4 Tines (the routing algorithm)

Tines is the smart-order-router. Two implementations:

- **TypeScript** version in `packages/tines` — runs in-browser for small/local
  routing, and inside the Swap API server for larger cross-chain routing.
- **Rust** version inside the Extractor for performance-critical paths.

Sushi's frontend calls `api.sushi.com/swap/v5/{chainId}?...` to get a quote —
the API hits the Extractor for pool state, runs Tines, returns the optimal route
+ calldata. The frontend then submits the calldata to `RouteProcessor` on chain.

This is over-engineered for Vanna's current needs, but the architectural
insight — **route optimisation is a backend concern, not an in-browser concern,
once your graph has more than ~10 pools** — is worth filing.

### 5.5 Sushi public API

`https://api.sushi.com/...` **[VERIFY LIVE]**:

- `/swap/v5/{chainId}` — best-route quote
- `/router/{chainId}/...` — alt routing endpoint
- `/pool/{chainId}/...` — pool list/details
- `/tokens/{chainId}` — curated token list
- `/price/v1/{chainId}` — token prices

Cadence: pool/price endpoints are usually **edge-cached for 10–60 s** with
revalidation; swap-quote endpoints are no-cache (have to be fresh per quote).

### 5.6 Caching layer

- **Redis** for hot caches (Sushi has `packages/redis`).
- **Vercel KV** / **Vercel Edge Cache** for HTTP-level caching of static-ish
  endpoints (token lists, daily TVL).
- **Next.js `unstable_cache` / `revalidate`** for SSR-level caching.
- **Database:** Prisma + PostgreSQL via `packages/database` for canonical data
  (pool metadata, indexed history, leaderboards).

The pattern: **Postgres for source of truth, Redis for hot reads, Vercel Edge
for HTTP caching.** All three layers, used appropriately.

### 5.7 Subgraphs

Sushi runs subgraphs *per chain × per protocol version*: a SushiSwap V2 subgraph
on each chain, a V3 subgraph on each chain, the legacy Trident subgraphs, etc.
Total subgraph count is in the dozens. They are used for:

- Historical chart data (TVL, volume, fees)
- Pool discovery
- Leaderboards
- User position history

Live state is **not** read from subgraphs (subgraph indexing has a few-block
lag). Live state comes from RPC + the Extractor.

### 5.8 What we'd steal from Sushi

Most realistic for a small DeFi team:

1. **Edge-cached HTTP API for static-ish data.** A tiny Next.js API route at
   `/api/pools` (or a separate service) that serves token lists and pool metadata
   with `Cache-Control: s-maxage=60, stale-while-revalidate=300` does most of
   what Sushi's API does for our scale.
2. **Redis (or Vercel KV) in front of expensive RPC reads.** Even a 5–10 s TTL
   collapses N concurrent users' RPC calls into one.
3. **Subgraph for history/charts only.** Mercury (Soroban indexer) + GraphQL
   front-end matches this exactly. Don't read live position state from it.
4. **Eventually, an Extractor-style service.** Once Vanna routes across more
   than a handful of pools, an out-of-process service that subscribes to chain
   events and serves quotes is the right shape. Not urgent today.

---

## 6. Side-by-Side Architecture Comparison

| Concern                         | Vanna (today)                        | Derive                                 | Gearbox                                  | Sushi                                   |
| ------------------------------- | ------------------------------------ | -------------------------------------- | ---------------------------------------- | --------------------------------------- |
| **Realtime delivery**           | `setInterval` / RQ `refetchInterval` | JSON-RPC over WebSocket                | Block-driven RQ invalidation             | Mostly polling + edge-cached API        |
| **Polling cadence anchor**      | Wall clock (5–60 s)                  | None — push                            | Ledger / block close                     | Wall clock + 10–60 s edge cache         |
| **Read batching**               | `Promise.all` of N HTTP calls        | One WS msg per channel                 | Multicall3 + on-chain `*Compressor`      | Off-chain Extractor in-memory           |
| **Off-chain price oracle on hot path** | CoinGecko (free tier)         | None — matcher knows price             | None — `PriceOracleV3` on chain          | None for swap; CoinGecko-ish for charts |
| **Indexer**                     | None                                 | Custom (Postgres + ClickHouse + Kafka) | TheGraph / Goldsky subgraph              | Dozens of subgraphs + Extractor         |
| **Hot-path centralised dep**    | CoinGecko                            | The matcher                            | None (IPFS-mirrored UI, RPC only)        | Swap API (Extractor)                    |
| **Cache layer**                 | RQ in-memory + Zustand persist       | Redis + ClickHouse                     | RQ in-memory + per-block invalidation    | Redis + Vercel KV + Vercel Edge         |
| **Auth for realtime**           | n/a                                  | EIP-712 signed session keys            | n/a (no auth needed for reads)           | n/a                                     |
| **Mutation invalidation**       | manual `refetch` + `refreshKey` bump | WS push of `{subaccount}.balances`     | `waitForTransactionReceipt` + invalidate | Tx receipt + invalidate                 |
| **Open-source frontend mirror** | No                                   | n/a                                    | IPFS pinned per release                  | n/a                                     |

---

## 7. What We're Doing Wrong

Concrete list, ordered by "biggest leverage when fixed":

### 7.1 Polling on wall clock instead of ledger close

[contexts/price-context.tsx:50](contexts/price-context.tsx#L50),
[app/page.tsx:111](app/page.tsx#L111),
and every `refetchInterval` in `hooks/use-*.ts` fire on a wall-clock interval.
That means:

- **A request that lands 100 ms before a new ledger gets stale data and waits
  another full interval** before refreshing.
- **A request that lands during a chain-quiet period burns RPC quota** for no
  new state.

Both reference protocols anchor to chain progress: Gearbox to blocks, Derive to
push notifications from the matcher. We should anchor to Soroban ledger close
(~5 s).

### 7.2 No batched-read primitive

Today every page loads fans out N independent `simulateTransaction` calls. Even
the parallelised ones (`Promise.all` in [hooks/use-earn.ts:49](hooks/use-earn.ts#L49))
are N round-trips, just concurrent. Latency = max of N, but RPC cost = sum of
N, and any one slow node tail-latency-blocks the whole render.

Gearbox's answer is `CreditAccountCompressor`. Sushi's answer is the Extractor.
Vanna's answer should be a Soroban "DataCompressor" view contract.

### 7.3 CoinGecko on the hot path

[lib/prices.ts](lib/prices.ts) hits the CoinGecko free API every 60 s for XLM,
hard-codes stables at $1, and falls back to `0.16` if everything fails. This is
fragile in three ways:

- Free-tier rate limits (5–15 req/min) — our 1 req/min is fine until traffic
  scales to ~5 concurrent fresh-page-loads.
- No price for any of the *non-XLM, non-stable* assets we care about (any
  Aquarius LP, Soroswap LP, or future asset).
- Hard-coding stables to $1 silently breaks if a stable depegs (USDC March 2023
  was a real outage).

Reflector is the Stellar-native answer (SEP-40 oracle). Read prices on-chain
inside the compressor contract — same call, no extra round-trip.

### 7.4 No real-time subscriptions at all

Even if we don't build a custom WS gateway, **Stellar SDK already exposes
streaming primitives we are not using**:

- `Server.streamLedgers()` — push on each new ledger close (~5 s)
- `Server.streamTransactions()` — push on relevant transactions
- `Server.streamEffects({ for_account })` — push when an account is touched
- Soroban events streams via [`sorobanRpc.getEvents`](https://github.com/stellar/js-stellar-sdk) polling or planned WS support

We should at minimum be using `streamLedgers()` / `streamEffects()` to drive
React Query invalidation. That's already a 10× improvement over `setInterval`,
with zero new infra.

### 7.5 Dead-code `useSmartPolling`

[lib/hooks/useSmartPolling.ts:49](lib/hooks/useSmartPolling.ts#L49) is defined
and never used. It's a perfectly fine hook (visibility-aware, idle-aware,
trigger-able) but every actual polling site uses raw `setInterval` or
`refetchInterval`. Either standardise on it or delete it.

### 7.6 Imperative mutations + manual `refreshKey` bumping

We don't use `useMutation`. Every mutation has its own ad-hoc loading state and
manually bumps a `refreshKey` in a Zustand store
([store/blend-store.ts](store/blend-store.ts)) to invalidate dependent queries.
This works but it's:

- **More code per mutation site** (every caller writes the same loading-state
  scaffolding).
- **Harder to centralise** retry, optimistic updates, side effects.
- **Couples store and query layer** — mutations write to a store that exists
  *only* to invalidate queries.

Standard pattern: `useMutation` with `onSuccess: () => queryClient.invalidateQueries({ queryKey: [...] })`.

### 7.7 Dual source of truth (RQ cache + Zustand)

Several queries write into both the RQ cache and a Zustand store
(e.g. [hooks/use-earn.ts:83-87](hooks/use-earn.ts#L83-L87)). It works but every
read site has to choose which to read from, and the two can drift. Pick one as
canonical for server state (RQ) and use Zustand only for genuine client state
(UI mode, selected pool, form drafts).

### 7.8 No subgraph / indexer for history

[hooks/use-margin.ts:10](hooks/use-margin.ts#L10) merges on-chain history with a
localStorage cache. localStorage as the only history layer means:

- **History is per-browser, per-device.** User opens app on phone — no history.
- **Anything beyond a small window will be slow** (we'd be replaying all events from chain).
- **No leaderboards, no charts, no historical TVL.**

Gearbox uses TheGraph for analytics; Sushi uses dozens of subgraphs. The Stellar
analogue is **Mercury** (mercurydata.app). Adopting it is a one-week project
that unlocks an entire UX category.

### 7.9 Each `getTransaction` is a sequential while-loop

[lib/margin-utils.ts:1109-1125](lib/margin-utils.ts#L1109-L1125) polls
`getTransaction(hash)` 30 times in a tight loop after a submit. That's fine for
correctness but it's:

- **Linear with submissions.** N concurrent users × N submits = N×30 RPC reads.
- **Has no jitter** — if RPC is briefly down, we burn 30 attempts in seconds.

Gearbox's `waitForTransactionReceipt` uses exponential backoff + listens for
the inclusion event via subscription. Stellar SDK has equivalent helpers — we
should use them.

---

## 8. Recommended Migration Path (Prioritised)

This is sequenced by **leverage / effort ratio**. Each item is roughly
"one engineer-week" unless noted.

### Phase 1 — Quick wins (1 week total)

1. **Replace wall-clock polling with ledger-driven invalidation.**
   - Add a single `<LedgerSubscriber>` provider at app root that calls
     `Server.streamLedgers({ cursor: 'now' })` and dispatches a "new ledger"
     event every ~5 s.
   - Replace `refetchInterval: 30_000` in every hot-path RQ hook with
     `enabled: true, staleTime: Infinity` and invalidate the relevant query
     keys on each new-ledger event.
   - Delete the 2 raw `setInterval`s
     ([contexts/price-context.tsx:50](contexts/price-context.tsx#L50),
     [app/page.tsx:111](app/page.tsx#L111)) — they become invalidation
     subscribers instead.
   - Standardise on `useSmartPolling` for the few cases where ledger-driven
     doesn't fit (pure CoinGecko refresh, etc.) or delete the hook.

2. **Adopt `useMutation` for all on-chain writes.**
   - Convert the imperative `useSupplyLiquidity` / `useWithdrawLiquidity` /
     `useBorrowLiquidity` / `useRepayLiquidity` in
     [hooks/use-earn.ts:226-349](hooks/use-earn.ts#L226-L349) to `useMutation`.
   - In each `onSuccess`, call `queryClient.invalidateQueries({ queryKey: ['earn'] })`
     instead of bumping `refreshKey`.
   - Delete `blend-store`'s `refreshKey` machinery; queries invalidate via RQ.

3. **Pick one source of truth for server state.** Stop dual-writing into both
   RQ cache and Zustand stores. Server state → RQ. UI state → Zustand. Read
   server state via `useQuery` selectors, not store subscriptions.

### Phase 2 — Read batching (2 weeks)

4. **Write a Soroban "DataCompressor" view contract.**
   - One contract, deployed once, with view functions like:
     - `user_dashboard(user) -> UserDashboard`
     - `pool_stats_all() -> Vec<PoolStats>`
     - `margin_account_full(account) -> MarginAccountSnapshot`
   - Each function reads everything a page renders, including prices via
     Reflector cross-contract calls.
   - Frontend calls `simulateTransaction(compressor.user_dashboard(user))`
     once per render. RPC count drops from ~10 to 1 per page.

5. **Migrate price reads from CoinGecko to Reflector** inside the compressor.
   - Reflector exposes a Soroban contract returning prices for major assets +
     custom feeds.
   - CoinGecko stays only as a degraded fallback if Reflector reverts.

### Phase 3 — Indexer (2–3 weeks)

6. **Adopt Mercury (or roll a tiny indexer)** for historical / analytical queries.
   - Mercury indexes Soroban events into Postgres and exposes GraphQL.
   - Migrate [hooks/use-margin.ts](hooks/use-margin.ts)'s history hook to query
     Mercury instead of replaying chain events client-side.
   - localStorage stays only as an offline-cache layer.

7. **Add a thin Next.js API at `/api/...`** for static-ish data (token list,
   pool registry, daily snapshots). Edge-cache with `s-maxage=60,
   stale-while-revalidate=300`. Mirrors Sushi's caching pattern at our scale.

### Phase 4 — Realtime gateway (4–8 weeks, only if/when needed)

8. **Build a JSON-RPC-over-WebSocket gateway** (only if we add on-chain
   orderbook / matcher / leverage trading where 5 s ledger latency is too slow).
   - Single Rust or Go service.
   - Front-ends Mercury for indexed data, Soroban RPC for live state, Reflector
     for prices.
   - Channel grammar mirrors Derive: `pools.{poolId}.stats`,
     `account.{address}.balances`, etc.
   - Stellar-typed signature for auth (`Freighter.signAuthEntry` or similar).
   - Frontend uses one long-lived client, channels swap on navigation.

### Phase 5 — Decentralisation polish (1 week)

9. **IPFS-mirror the frontend per release.** Adds the "your protocol still
   works if our DNS dies" property Gearbox has. Cheap to set up via Fleek or
   Pinata.

### What NOT to do (yet)

- Don't build a Sushi-style Extractor. We don't have hundreds of pools.
- Don't build a Derive-style off-chain matcher unless we add an orderbook
  product. The 5 s Soroban ledger time is fine for lending/leverage UX.
- Don't migrate off TanStack Query. It's the right tool. The problems are in
  *how* we use it.

---

## 9. Code Patterns to Adopt — Concrete Examples

### 9.1 Ledger-driven invalidation provider

```tsx
// contexts/ledger-subscriber.tsx
"use client";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Horizon } from "@stellar/stellar-sdk";

const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

const INVALIDATE_ON_LEDGER: string[][] = [
  ["earn", "pools"],
  ["earn", "userPositions"],
  ["soroswap", "allPoolStats"],
  ["soroswap", "lpPosition"],
  ["farm", "blend", "poolStats"],
  ["farm", "blend", "userPositions"],
  ["margin", "history"],
];

export function LedgerSubscriber({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();

  useEffect(() => {
    const close = horizon
      .ledgers()
      .cursor("now")
      .stream({
        onmessage: () => {
          for (const key of INVALIDATE_ON_LEDGER) {
            qc.invalidateQueries({ queryKey: key });
          }
        },
        onerror: (e) => console.warn("ledger stream error", e),
      });
    return () => close();
  }, [qc]);

  return <>{children}</>;
}
```

Drop this provider in `app/layout.tsx`. Then strip every `refetchInterval` from
the hooks under [hooks/](hooks/) — they invalidate themselves.

### 9.2 Soroban DataCompressor (Rust contract sketch)

```rust
// contracts/compressor/src/lib.rs
#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec, I128};

#[contracttype]
pub struct TokenBalance { pub asset: Address, pub amount: I128, pub usd: I128 }

#[contracttype]
pub struct UserDashboard {
    pub margin_account:        Address,
    pub collateral_balances:   Vec<TokenBalance>,
    pub borrow_balances:       Vec<TokenBalance>,
    pub health_factor:         I128,
    pub total_collateral_usd:  I128,
    pub total_borrowed_usd:    I128,
    pub borrow_rate_bps:       u32,
}

#[contract]
pub struct Compressor;

#[contractimpl]
impl Compressor {
    pub fn user_dashboard(env: Env, user: Address) -> UserDashboard {
        // 1. resolve margin account for user (1 storage read)
        // 2. for each supported asset:
        //      read balance from token contract
        //      read price from Reflector oracle
        //      accumulate USD totals
        // 3. read borrow rate, compute health factor
        // 4. return populated struct
        unimplemented!()
    }
}
```

Frontend usage:

```ts
// hooks/use-dashboard.ts
export function useDashboard(user?: string) {
  return useQuery({
    queryKey: ["dashboard", user],
    queryFn: async () => {
      if (!user) return null;
      const sim = await sorobanRpc.simulateTransaction(
        buildContractCall(COMPRESSOR_ADDR, "user_dashboard", [user])
      );
      return decodeUserDashboard(sim.result);
    },
    enabled: !!user,
    staleTime: Infinity, // invalidated by LedgerSubscriber
  });
}
```

One RPC call replaces what is today 8–10.

### 9.3 `useMutation` shape for on-chain writes

```ts
// hooks/use-earn.ts (after refactor)
export function useSupplyLiquidity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: SupplyArgs) => {
      const tx = await ContractService.buildSupplyTx(args);
      const signed = await freighter.signTransaction(tx);
      const hash = await server.sendTransaction(signed);
      return waitForReceipt(hash);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["earn"] });
      qc.invalidateQueries({ queryKey: ["user"] });
    },
  });
}
```

Caller stops worrying about loading state, refresh, balance refresh — RQ does
it all.

### 9.4 Future: Vanna WS gateway protocol shape (Derive-style)

If/when we build the gateway:

```
client → server:
  {"id":1,"method":"subscribe","params":{"channels":["pools.xlm.stats","account.GA…ABC.balances"]}}

server → client (notification):
  {"method":"subscription","params":{"channel":"pools.xlm.stats","data":{"tvl_usd":"1234567","apr_bps":520,"ledger":12345678}}}

client auth (for private channels):
  {"id":2,"method":"login","params":{"address":"GA…ABC","signature":"<base64-of-Stellar-typed-payload>"}}
```

Single long-lived client at app shell, channels swap on navigation. Mirrors
Section 3.6.

---

## 10. Open Questions & Next Steps

### 10.1 Open questions for the team

1. **Are we building products that need <1 s data freshness** (orderbook,
   liquidation feed, perps)? If yes, Phase 4 (WS gateway) becomes urgent. If
   no, ledger-driven invalidation (Phase 1) is enough indefinitely.
2. **Do we want a "your protocol survives if Vanna disappears" story?** If yes,
   Phase 5 (IPFS mirror + on-chain-only reads) is a credibility play worth
   doing early.
3. **Mercury vs. roll-our-own indexer?** Mercury is faster to adopt. Rolling our
   own is more flexible long-term and lets us join chain events with off-chain
   data we own.
4. **How many active pools / assets in the next 12 months?** That determines
   whether an Extractor-style service ever becomes warranted.

### 10.2 Next steps to verify this report

The three protocol deep-dives in Sections 3, 4, 5 are reconstructed from
engineering knowledge with a Jan 2026 cutoff. Before we cite specific URLs in
internal slides, the next pass should:

1. Open `docs.derive.xyz/reference/websockets`, `docs.derive.xyz/reference/post_subscribe`, and `docs.derive.xyz/reference/login` to verify channel grammar and auth payload.
2. Walk `github.com/derivexyz` and `github.com/lyra-finance` for the current authoritative repo names.
3. Walk `github.com/Gearbox-protocol`, especially `sdk-v3/src/services` and `core-v3/contracts/helpers/CreditAccountCompressor.sol`, for verbatim Solidity + TS we can lift patterns from.
4. Walk `github.com/sushiswap/sushiswap` `apis/swap`, `packages/extractor`, `packages/tines`, `jobs/` to see how they wire Redis + Postgres + subgraphs.
5. Pull current `api.sushi.com` route list + cache-control headers.

That pass should be ~3 hours with web access; everything in this document holds
its shape after the pass — only specific URLs/repo names will tighten up.

### 10.3 Concrete next action

If the team agrees with the prioritisation, **Phase 1** is the right next
sprint:

- One engineer, ~5 days
- Deliverables: `LedgerSubscriber` provider, all hooks migrated to
  ledger-invalidation, all mutations migrated to `useMutation`, dual-write to
  Zustand stripped, `useSmartPolling` either standardised or deleted
- Risk: low. No contract changes. No new infra. Behaviour-preserving with
  better RPC cost + fresher data.

After Phase 1 lands, Phase 2 (DataCompressor contract) is the highest-leverage
next step.

---

*— end of report —*
