# Vanna Backend — Implementation Plan (10k DAU Ready)

> **The "go and build this" document.** Day-by-day sprints, real code stubs,
> file paths, scaling math. Supersedes [FINAL_PLAN.md](FINAL_PLAN.md) for
> day-to-day execution. Read [BACKEND_RESEARCH.md](BACKEND_RESEARCH.md) and
> [PROTOCOL_BACKEND_PLAN.md](PROTOCOL_BACKEND_PLAN.md) for the *why*.
>
> **Outcome:** Production stack handling 10k DAU at $1,500–2,000/mo.
> **Duration:** 6 weeks (30 working days).
> **Team:** 1 frontend eng + 1 Soroban dev (S2 only) + 1 DevOps (S6 only).

---

## The Stack (one diagram, memorise this)

```
┌──────────────────────────────────────────────────────────────────┐
│  USER BROWSER                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Next.js 16 + React 19 + TanStack Query                     │  │
│  │                                                            │  │
│  │ <LedgerSubscriberProvider>                                 │  │
│  │   ├─ Horizon SSE (streamLedgers)                           │  │
│  │   └─ Soroban getEvents poll (5s)                           │  │
│  │       └─ qc.invalidateQueries on every state change        │  │
│  │                                                            │  │
│  │ Hooks → fetch from /api/* (NOT direct RPC)                 │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                │                                    │
                ▼                                    ▼
┌──────────────────────────────┐         ┌────────────────────────┐
│ VERCEL EDGE (CDN cached)     │         │ MERCURY (managed)      │
│                              │         │ GraphQL endpoint       │
│ /api/snapshot       4s TTL   │         │ 12 event topics indexed│
│ /api/account/[addr] 3s SWR   │         │ Trader history,        │
│ /api/analytics/*    5min TTL │         │ leaderboard, lp search │
│                              │         └────────────────────────┘
│ ↓ on cache MISS only:        │
└──────────────────────────────┘
                │
                ▼
┌──────────────────────────────┐
│ SOROBAN RPC (2 nodes HA)     │
│ Validation Cloud / Blockdaemon│
└──────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────────┐
│ ON-CHAIN — Soroban contracts                                     │
│                                                                  │
│ ┌────────────────────────┐    ┌──────────────────────────────┐  │
│ │ ProtocolViewContract   │───▶│ Existing protocol contracts   │  │
│ │ (NEW — compressor)     │    │ Registry, AccountManager,     │  │
│ │                        │    │ SmartAccount, RiskEngine,     │  │
│ │ get_user_full_view()   │    │ Oracle (wraps Reflector),     │  │
│ │ get_protocol_snapshot()│    │ LendingPool{XLM,USDC,EURC},   │  │
│ │ get_accounts_batch()   │    │ vTokens, TrackingToken        │  │
│ └────────────────────────┘    └──────────────────────────────┘  │
│                                              │                   │
│                                              │ events emitted    │
└──────────────────────────────────────────────┼───────────────────┘
                                               ▼
                              ┌──────────────────────────────┐
                              │ MERCURY + STELLAR HUBBLE BQ  │
                              │ (event indexers, see above)  │
                              └──────────────────────────────┘
```

---

## Why This Survives 10k DAU — The Math

### Without edge cache (broken)

10k users × 1 sim per ledger close (~5s) = **2,000 sims/sec sustained**.
Public Soroban RPC saturates at ~50–200 req/s. **Crashes immediately.**

### With edge cache (works)

`get_protocol_snapshot()` (pool stats + prices) is **identical for all users**.
Cache it on Vercel Edge for 4 seconds.

| Read type | Frequency | Per-user? | Cache hit? | RPC calls/min at 10k DAU |
| --------- | --------- | --------- | ---------- | ------------------------- |
| `get_protocol_snapshot` | every 5s | No | ✅ Edge cached | **~12 / min** (1 per 5s globally) |
| `get_account_view(user)` | every 5s | Yes | ⚠️ Per-user SWR | ~120,000 / min worst case |
| Mercury queries | on-demand | Mixed | Mercury-cached | 0 RPC calls |
| Hubble queries | on-demand | No | Edge 5min TTL | 0 RPC calls |

**Per-user reads are the real load.** Even after edge SWR, 10k users × 1 read /
5s = 2k req/s on `/api/account/[addr]`. At Vercel Edge that's fine (edge runs
worldwide, autoscales). The downstream hits are mitigated by:

1. **3s SWR cache** in edge per (address) key — if same user opens 3 tabs,
   only 1 RPC call.
2. **Stale-while-revalidate** — cache returns stale data instantly, refreshes
   in background. User never waits.
3. **2 RPC nodes in HA** — split load + failover.

Result: **~2,000 sims/sec → ~200–400 actual sims/sec hitting RPC**. Comfortably
within 2× hosted RPC capacity (~500–1000 req/s each).

### Cost at 10k DAU

| Item | Monthly |
| ---- | ------- |
| 2× Soroban RPC HA (Validation Cloud) | $500–800 |
| 1× Horizon hosted | $300–500 |
| Mercury Pro | $200–400 |
| Vercel Pro + edge functions | $50–150 |
| Cloudflare CDN (optional) | $0–100 |
| Sentry + Grafana | $50–150 |
| **Total** | **$1,100–2,100/mo** |

---

## Sprint Schedule (6 weeks, 30 working days)

| Sprint | Days | Owner | Theme |
| ------ | ---- | ----- | ----- |
| **S1** | Day 1–5 | 1 FE | Frontend rewire — kill polling/CoinGecko |
| **S2** | Day 6–15 | 1 FE + 1 Soroban | Compressor contract |
| **S3** | Day 16–18 | 1 FE | Edge cache layer |
| **S4** | Day 19–23 | 1 FE | Mercury indexer |
| **S5** | Day 24–26 | 1 FE | Hubble analytics |
| **S6** | Day 27–30 | 1 DevOps + 1 FE | Production infra + load test |

---

## Sprint 1 — Frontend Rewire (Day 1–5)

**Goal:** Zero `setInterval` for data. Zero `refetchInterval`. Ledger-tick
drives everything. CoinGecko deleted.

### Day 1 — Build LedgerSubscriberProvider

Create [contexts/ledger-subscriber.tsx](contexts/ledger-subscriber.tsx):

```tsx
"use client";
import React, { createContext, useContext, useEffect, useState } from "react";
import { useQueryClient, QueryClient } from "@tanstack/react-query";
import { Horizon, rpc as sorobanRpc } from "@stellar/stellar-sdk";

type LedgerCtx = { tick: number; latestLedger: number };
const Ctx = createContext<LedgerCtx>({ tick: 0, latestLedger: 0 });
export const useLedgerTick = () => useContext(Ctx);

const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL!;
const SOROBAN_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL!;

const WATCHED_CONTRACTS = [
  process.env.NEXT_PUBLIC_ACCOUNT_MANAGER_ADDR!,
  process.env.NEXT_PUBLIC_LENDING_POOL_USDC!,
  process.env.NEXT_PUBLIC_LENDING_POOL_XLM!,
  process.env.NEXT_PUBLIC_LENDING_POOL_EURC!,
  process.env.NEXT_PUBLIC_LENDING_POOL_AQUARIUS_USDC!,
  process.env.NEXT_PUBLIC_LENDING_POOL_SOROSWAP_USDC!,
];

export function LedgerSubscriberProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [tick, setTick] = useState(0);
  const [latestLedger, setLatestLedger] = useState(0);

  // STREAM A — Horizon SSE: tick on every ledger close
  useEffect(() => {
    const horizon = new Horizon.Server(HORIZON_URL);
    const close = horizon.ledgers().cursor("now").stream({
      onmessage: (ledger: any) => {
        setLatestLedger(Number(ledger.sequence));
        setTick((t) => t + 1);
        qc.invalidateQueries({ queryKey: ["snapshot"] });
        qc.invalidateQueries({ queryKey: ["accountView"] });
      },
      onerror: (e: unknown) => console.warn("[ledger] err", e),
    });
    return () => close();
  }, [qc]);

  // STREAM B — Soroban events poll (every 5s) — drives Mercury invalidation
  useEffect(() => {
    const soroban = new sorobanRpc.Server(SOROBAN_URL);
    let stop = false;
    let cursor: string | undefined;

    async function loop() {
      while (!stop) {
        try {
          if (!cursor) {
            const latest = await soroban.getLatestLedger();
            cursor = String(latest.sequence - 5);
          }
          const resp = await soroban.getEvents({
            startLedger: Number(cursor),
            filters: [{ type: "contract", contractIds: WATCHED_CONTRACTS }],
            limit: 100,
          });
          for (const ev of resp.events) {
            handleEvent(ev, qc);
            cursor = ev.pagingToken;
          }
        } catch (e) { console.warn("[events] err", e); }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    loop();
    return () => { stop = true; };
  }, [qc]);

  return <Ctx.Provider value={{ tick, latestLedger }}>{children}</Ctx.Provider>;
}

function handleEvent(ev: any, qc: QueryClient) {
  const topic = ev.topic?.[0]?.toString?.() ?? "";
  if (topic.startsWith("Trader_") || topic.includes("event")) {
    qc.invalidateQueries({ queryKey: ["accountView"] });
    qc.invalidateQueries({ queryKey: ["mercury", "history"] });
    qc.invalidateQueries({ queryKey: ["snapshot"] });
  }
  if (topic.includes("Smart_Account_")) {
    qc.invalidateQueries({ queryKey: ["accounts"] });
  }
}
```

Wrap [app/layout.tsx](app/layout.tsx):

```tsx
<QueryProvider>
  <LedgerSubscriberProvider>
    {children}
  </LedgerSubscriberProvider>
</QueryProvider>
```

**Day 1 acceptance:** `tick` increments roughly every 5s in DevTools. Console
logs no errors during a 30-min idle session.

### Day 2 — Replace CoinGecko with on-chain oracle

Create [hooks/use-oracle-prices.ts](hooks/use-oracle-prices.ts):

```ts
import { useQuery } from "@tanstack/react-query";
import { useLedgerTick } from "@/contexts/ledger-subscriber";
import { simulateContractCall } from "@/lib/stellar-utils";

const ORACLE = process.env.NEXT_PUBLIC_ORACLE_CONTRACT!;
const SUPPORTED = ["XLM", "USDC", "EURC"] as const;

export function useOraclePrices() {
  const { latestLedger } = useLedgerTick();
  return useQuery({
    queryKey: ["prices", latestLedger],
    queryFn: async () => {
      const results = await Promise.all(
        SUPPORTED.map(async (sym) => {
          const sim = await simulateContractCall(ORACLE, "get_price_latest", [sym]);
          const [price, decimals] = decodePrice(sim.result);
          return [sym, Number(price) / Math.pow(10, decimals)] as const;
        })
      );
      return Object.fromEntries(results) as Record<string, number>;
    },
    staleTime: 4_000,
  });
}

export function useTokenPrice(symbol: string): number {
  const { data } = useOraclePrices();
  return data?.[symbol.toUpperCase()] ?? 1;
}
```

**Delete:**
- [contexts/price-context.tsx](contexts/price-context.tsx)
- [lib/prices.ts](lib/prices.ts)

Replace every `useTokenPrice("XLM")` import — same name, new source. After
Sprint 2 lands, this hook gets killed too (prices come from compressor in one
sim).

### Day 3 — Migrate hooks: remove `refetchInterval`

For each file in [hooks/](hooks/):

| File | What to change |
| ---- | -------------- |
| [hooks/use-earn.ts](hooks/use-earn.ts) | Remove `refetchInterval: 30_000`. Add `useLedgerTick().tick` to `queryKey`. |
| [hooks/use-farm.ts](hooks/use-farm.ts) | Same pattern. |
| [hooks/use-soroswap.ts](hooks/use-soroswap.ts) | Remove `refetchInterval: 60_000` + `10_000`. Same pattern. |
| [hooks/use-margin.ts](hooks/use-margin.ts) | Remove `refetchInterval: 10_000`. Same pattern. |

Pattern:
```ts
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

Also delete the `setInterval` at [app/page.tsx:111](app/page.tsx#L111).

### Day 4 — Mutations to `useMutation`

Convert imperative mutations in [hooks/use-earn.ts](hooks/use-earn.ts) and
similar files:

```ts
// Before — imperative
export function useSupplyLiquidity() {
  return async (args: SupplyArgs) => {
    setLoading(true);
    const result = await ContractService.supply(args);
    blendStore.triggerRefresh(); // bumps refreshKey
    setLoading(false);
    return result;
  };
}

// After — useMutation
export function useSupplyLiquidity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: SupplyArgs) => ContractService.supply(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accountView"] });
      qc.invalidateQueries({ queryKey: ["snapshot"] });
      qc.invalidateQueries({ queryKey: ["earn"] });
    },
  });
}
```

Apply to: `useSupply*`, `useWithdraw*`, `useBorrow*`, `useRepay*`,
`useDepositCollateral*`, `useExecuteExternal*`.

### Day 5 — Cleanup + verify

- Delete `refreshKey` machinery from [store/blend-store.ts](store/blend-store.ts)
- Delete or standardise [lib/hooks/useSmartPolling.ts](lib/hooks/useSmartPolling.ts)
- Audit: `grep -rn "setInterval\|refetchInterval\|coingecko" .` returns nothing
- Verify dual-write removed: queries write *only* to RQ cache, not Zustand stores
- Manual test: deposit, borrow, repay, withdraw — UI updates in <5s after each tx

**Sprint 1 Done When:**
- [ ] `LedgerSubscriberProvider` wraps app
- [ ] Zero `setInterval` for data
- [ ] Zero `refetchInterval`
- [ ] Zero CoinGecko reference
- [ ] All mutations use `useMutation`
- [ ] All hooks invalidate via ledger tick
- [ ] App works end-to-end in testnet

---

## Sprint 2 — Compressor Contract (Day 6–15)

**Goal:** `ProtocolViewContract` deployed; dashboard does 1 sim per render.

### Day 6–7 — Contract scaffolding

Create `Protocol_V1_Soroban/contracts/ProtocolViewContract/`:

```
ProtocolViewContract/
├── Cargo.toml
└── src/
    ├── lib.rs        # Contract entry, mod imports
    ├── types.rs      # AccountView, PoolStats, ProtocolSnapshot, TokenBalanceUsd
    └── view.rs       # 4 view functions
```

`Cargo.toml`:
```toml
[package]
name = "protocol_view_contract"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
soroban-sdk = { workspace = true }
```

`types.rs` — full struct definitions in [PROTOCOL_BACKEND_PLAN.md §3.1](PROTOCOL_BACKEND_PLAN.md).

### Day 8–11 — Implement view functions

Full code skeleton in [PROTOCOL_BACKEND_PLAN.md §3.2](PROTOCOL_BACKEND_PLAN.md).
Key implementation notes:

- Use `Map<Symbol, U256>` price cache to call Oracle once per unique symbol
- For Blend tracking tokens, resolve underlying via existing
  `RiskEngine::blend_underlying_info` logic
- For canonical price symbol mapping (BLUSDC → USDC, AQUSDC → USDC, etc.),
  copy `RiskEngine::canonical_price_symbol`
- Cross-contract calls use `contractimport!` of compiled Wasm files —
  same pattern as `RiskEngineContract`
- Health factor formula: `(total_collateral_usd × WAD) / total_debt_usd`

### Day 12 — Build, deploy, test

```bash
cd Protocol_V1_Soroban
cargo build --release --target wasm32v1-none

stellar contract deploy \
  --wasm target/wasm32v1-none/release/protocol_view_contract.wasm \
  --source admin \
  --network testnet
```

Save deployed address to `Stellar_backend/.env.local`:
```
NEXT_PUBLIC_VIEW_CONTRACT=CXXXXXXXXX...
```

### Day 13 — Resource budget profiling

Test worst-case account on testnet:
```bash
stellar contract invoke \
  --id $VIEW_CONTRACT \
  --source-account admin \
  --network testnet \
  -- get_user_full_view --margin_account $TEST_ACCOUNT_WITH_5_COL_3_BORROW
```

Check `--cost` output:
- Instructions used: target <60M of 100M limit
- Read budget: target <300KB of 512KB limit

If over budget → split into separate `get_account_view` and
`get_protocol_snapshot` calls (already designed that way as fallback).

### Day 14 — Frontend codec

Create [lib/view-codec.ts](lib/view-codec.ts):

```ts
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type { AccountView, ProtocolSnapshot, TokenBalanceUsd, PoolStats } from "./view-types";

export function decodeAccountView(scval: xdr.ScVal): AccountView {
  const native = scValToNative(scval);
  return {
    margin_account:           native.margin_account,
    trader:                   native.trader,
    is_active:                native.is_active,
    has_debt:                 native.has_debt,
    collaterals:              native.collaterals.map(decodeTokenBalance),
    borrows:                  native.borrows.map(decodeTokenBalance),
    total_collateral_usd_wad: BigInt(native.total_collateral_usd_wad),
    total_borrows_usd_wad:    BigInt(native.total_borrows_usd_wad),
    health_factor_wad:        BigInt(native.health_factor_wad),
    is_healthy:               native.is_healthy,
    timestamp:                Number(native.timestamp),
  };
}

export function decodeProtocolSnapshot(scval: xdr.ScVal): ProtocolSnapshot { /* … */ }
function decodeTokenBalance(raw: any): TokenBalanceUsd { /* … */ }
```

### Day 15 — Migrate hooks to compressor

Create [hooks/use-user-full-view.ts](hooks/use-user-full-view.ts):

```ts
import { useQuery } from "@tanstack/react-query";
import { useLedgerTick } from "@/contexts/ledger-subscriber";

export function useUserFullView(marginAccount?: string) {
  const { latestLedger } = useLedgerTick();
  return useQuery({
    queryKey: ["userFullView", marginAccount, latestLedger],
    queryFn: async () => {
      if (!marginAccount) return null;
      const res = await fetch(`/api/account/${marginAccount}`);
      return res.json();
    },
    enabled: !!marginAccount,
    staleTime: 3_000,
  });
}
```

Refactor `usePoolData`, `useUserPositions`, `useBlendPoolStats`,
`useSoroswapPoolStats`, `useUserBlendPositions` into **selectors over
`useUserFullView`**:

```ts
// Before — many independent hooks
const { data: pools } = usePoolData();
const { data: positions } = useUserPositions();
const { data: stats } = useBlendPoolStats();

// After — one call, many selectors
const { data } = useUserFullView(marginAccount);
const pools = data?.snapshot.pools;
const collaterals = data?.account.collaterals;
const healthFactor = formatWad(data?.account.health_factor_wad);
```

**Sprint 2 Done When:**
- [ ] `ProtocolViewContract` deployed to testnet
- [ ] Resource budget profiling passes (<60M instructions worst case)
- [ ] Dashboard makes exactly 1 `simulateTransaction` per ledger tick
- [ ] Earn page makes exactly 1 sim
- [ ] Farm page makes exactly 1 sim
- [ ] Health factor / balances / APRs match pre-refactor values

---

## Sprint 3 — Edge Cache Layer (Day 16–18)

**Goal:** Survive 10k DAU. Make `/api/snapshot` and `/api/account/[addr]` the
sole entry points; bypass direct RPC from browser entirely.

### Day 16 — Build the global snapshot route

Create [app/api/snapshot/route.ts](app/api/snapshot/route.ts):

```ts
import { NextResponse } from "next/server";
import { rpc as sorobanRpc, Contract, TransactionBuilder, Networks, Account } from "@stellar/stellar-sdk";
import { decodeProtocolSnapshot } from "@/lib/view-codec";

export const runtime = "edge";
export const revalidate = 4;

const RPC_URL = process.env.SOROBAN_RPC_URL!;
const VIEW_CONTRACT = process.env.VIEW_CONTRACT_ADDR!;

export async function GET() {
  const server = new sorobanRpc.Server(RPC_URL);
  const dummy = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "0");
  const tx = new TransactionBuilder(dummy, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(VIEW_CONTRACT).call("get_protocol_snapshot"))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    return NextResponse.json({ error: sim.error }, { status: 502 });
  }

  const snapshot = decodeProtocolSnapshot(sim.result!.retval);
  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "public, s-maxage=4, stale-while-revalidate=10",
      "CDN-Cache-Control": "public, s-maxage=4",
    },
  });
}
```

**This route is the single biggest leverage point in the entire stack.** At
10k DAU it serves ~10k req/min from cache, not RPC.

### Day 17 — Build the per-user account route

Create [app/api/account/[addr]/route.ts](app/api/account/[addr]/route.ts):

```ts
import { NextResponse } from "next/server";
import { rpc as sorobanRpc, Contract, Address, TransactionBuilder, Networks, Account } from "@stellar/stellar-sdk";
import { decodeAccountView, decodeProtocolSnapshot } from "@/lib/view-codec";

export const runtime = "edge";

const RPC_URL = process.env.SOROBAN_RPC_URL!;
const VIEW_CONTRACT = process.env.VIEW_CONTRACT_ADDR!;

export async function GET(_req: Request, { params }: { params: { addr: string } }) {
  const { addr } = params;

  const server = new sorobanRpc.Server(RPC_URL);
  const dummy = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "0");
  const tx = new TransactionBuilder(dummy, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(VIEW_CONTRACT).call("get_user_full_view", new Address(addr).toScVal()))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    return NextResponse.json({ error: sim.error }, { status: 502 });
  }

  const tuple = (sim.result!.retval as any).vec();
  const account = decodeAccountView(tuple[0]);
  const snapshot = decodeProtocolSnapshot(tuple[1]);

  return NextResponse.json({ account, snapshot }, {
    headers: {
      "Cache-Control": "public, s-maxage=3, stale-while-revalidate=8",
      "CDN-Cache-Control": "public, s-maxage=3",
    },
  });
}
```

### Day 18 — Wire frontend to API routes, load test

Update [hooks/use-user-full-view.ts](hooks/use-user-full-view.ts) and
[hooks/use-protocol-snapshot.ts](hooks/use-protocol-snapshot.ts) to fetch from
`/api/...` instead of direct RPC.

**Local load test:**
```bash
# Install k6 or use ab
ab -n 10000 -c 100 https://your-vercel-deployment.vercel.app/api/snapshot

# Expected:
# - p99 latency < 100ms
# - RPC calls during test: ~25 (1 per 4s × 100s) — proves caching works
```

**Sprint 3 Done When:**
- [ ] `/api/snapshot` returns 200 with proper Cache-Control headers
- [ ] `/api/account/[addr]` returns 200 per-user
- [ ] Frontend hooks fetch from `/api/...`, never direct RPC
- [ ] 10k req in 5s on `/api/snapshot` results in <5 RPC calls
- [ ] Browser network tab shows `cache-control: s-maxage=4` headers

---

## Sprint 4 — Mercury Indexer (Day 19–23)

**Goal:** Trader history, leaderboard, and `get_lenders_*` queries off-chain.

### Day 19 — Mercury account setup

1. Sign up at [mercurydata.app](https://mercurydata.app) — Pro tier
2. Add network: testnet (then mainnet later)
3. Add contracts to index:
   - `AccountManagerContract` address
   - `LendingProtocolXLM/USDC/EURC` addresses
   - `LendingProtocolAquariusUsdc`, `LendingProtocolSoroswapUsdc` addresses

### Day 20 — Define entities

Configure these 12 event-sourced entities in Mercury dashboard. All are
auto-derivable from event payloads (no Retroshades needed for v1):

| Entity            | Source event topic          |
| ----------------- | --------------------------- |
| AccountCreated    | `Smart_account_creation`    |
| AccountClosed     | `Smart_Account_Closed`      |
| AccountActivated  | `Smart_Account_Activated`   |
| AccountDeactivated| `Smart_Account_Deactivated` |
| Borrow            | `Trader_Borrow`             |
| Repay             | `Trader_Repay_Event`        |
| Liquidation       | `Trader_Liquidate_Event`    |
| Settle            | `Trader_SettleAccount_Event`|
| LenderDeposit     | `deposit_event`             |
| LenderWithdraw    | `withdraw_event`            |
| VTokenMint        | `mint_event`                |
| VTokenBurn        | `burn_event`                |

### Day 21 — Build Mercury client + hooks

Create [lib/mercury-client.ts](lib/mercury-client.ts):

```ts
import { GraphQLClient, gql } from "graphql-request";

export const mercury = new GraphQLClient(process.env.NEXT_PUBLIC_MERCURY_URL!, {
  headers: { authorization: `Bearer ${process.env.NEXT_PUBLIC_MERCURY_KEY}` },
});

export const HISTORY_QUERY = gql`
  query History($acc: String!) {
    borrows(where: { smart_account_eq: $acc }, orderBy: timestamp_DESC, first: 100) {
      smart_account
      token_symbol
      token_amount
      timestamp
      tx_hash
    }
    repays(where: { smart_account_eq: $acc }, orderBy: timestamp_DESC, first: 100) {
      smart_account
      token_symbol
      token_amount
      timestamp
      tx_hash
    }
    liquidations(where: { smart_account_eq: $acc }) {
      smart_account
      timestamp
      tx_hash
    }
  }
`;

export const LEADERBOARD_QUERY = gql`
  query Leaderboard($limit: Int!) {
    topBorrowers: borrows(orderBy: token_amount_DESC, first: $limit) {
      smart_account
      token_amount
    }
  }
`;
```

Create [hooks/use-trader-history.ts](hooks/use-trader-history.ts):

```ts
import { useQuery } from "@tanstack/react-query";
import { mercury, HISTORY_QUERY } from "@/lib/mercury-client";

export function useTraderHistory(marginAccount?: string) {
  return useQuery({
    queryKey: ["mercury", "history", marginAccount],
    queryFn: () => mercury.request(HISTORY_QUERY, { acc: marginAccount }),
    enabled: !!marginAccount,
    staleTime: 30_000,
  });
}
```

### Day 22 — Migrate `use-margin.ts`, kill `get_lenders_usdc()` reads

- Replace localStorage history merge in [hooks/use-margin.ts](hooks/use-margin.ts) with `useTraderHistory`
- Delete the `LendingPoolUSDC.get_lenders_usdc()` chain read in any FE hook — replace with Mercury query

### Day 23 — Verify

After a real `borrow()` transaction on testnet:
- Mercury entity `Borrow` shows the new row within ~10 s
- Frontend `useTraderHistory` returns the new entry on next refetch

**Sprint 4 Done When:**
- [ ] Mercury indexes all 12 entities
- [ ] `useTraderHistory` returns data in <500ms
- [ ] localStorage history merge deleted
- [ ] No on-chain `get_lenders_*` calls in frontend

---

## Sprint 5 — Hubble Analytics (Day 24–26)

**Goal:** Free deep analytics for `/stats` page.

### Day 24 — BigQuery setup

1. Create GCP project, enable BigQuery
2. Service account with `BigQuery Job User` + `BigQuery Data Viewer`
3. Save key JSON to Vercel env: `GOOGLE_CREDS_JSON`
4. Verify access:
   ```sql
   SELECT COUNT(*) FROM `crypto-stellar.crypto_stellar.contract_events` LIMIT 1;
   ```

### Day 25 — Build 4 analytics API routes

Create [app/api/analytics/tvl/route.ts](app/api/analytics/tvl/route.ts):

```ts
import { NextResponse } from "next/server";
import { BigQuery } from "@google-cloud/bigquery";

const bq = new BigQuery({ credentials: JSON.parse(process.env.GOOGLE_CREDS_JSON!) });

export const revalidate = 300;

export async function GET() {
  const [rows] = await bq.query({
    query: `
      SELECT DATE(closed_at) AS day,
             SUM(CAST(JSON_VALUE(data, '$.amount') AS NUMERIC)) / 1e18 AS tvl_usd
      FROM \`crypto-stellar.crypto_stellar.contract_events\`
      WHERE topic_0 IN ('deposit_event','withdraw_event')
        AND contract_id IN (@usdc_pool, @xlm_pool, @eurc_pool)
      GROUP BY day ORDER BY day DESC LIMIT 90
    `,
    params: {
      usdc_pool: process.env.LENDING_POOL_USDC!,
      xlm_pool:  process.env.LENDING_POOL_XLM!,
      eurc_pool: process.env.LENDING_POOL_EURC!,
    },
  });
  return NextResponse.json(rows, {
    headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" },
  });
}
```

Repeat for `/api/analytics/top-borrowers`, `/api/analytics/volume`,
`/api/analytics/liquidations` — full SQL in [FINAL_PLAN.md Sprint 5](FINAL_PLAN.md).

### Day 26 — Stats page

Build/refactor `/stats` page consuming the 4 analytics endpoints. Use existing
chart libs (`lightweight-charts`, `chart.js`, `react-chartjs-2` already in
package.json).

**Sprint 5 Done When:**
- [ ] `/stats` renders TVL chart, volume chart, top borrowers, liquidation feed
- [ ] All routes cached `s-maxage=300`
- [ ] BigQuery month-to-date cost: $0 (free tier)

---

## Sprint 6 — Production Infra (Day 27–30)

**Goal:** HA infra + monitoring + load test green.

### Day 27 — RPC + Horizon hosting

1. Sign up Validation Cloud (or Blockdaemon) — production tier
2. Provision 2 Soroban RPC endpoints (different regions)
3. Provision 1 Horizon endpoint
4. Update env vars:
   ```
   SOROBAN_RPC_URL=https://primary.validationcloud.io/...
   SOROBAN_RPC_FALLBACK=https://secondary.validationcloud.io/...
   HORIZON_URL=https://horizon.validationcloud.io/...
   ```
5. Add fallback logic in [lib/stellar-utils.ts](lib/stellar-utils.ts):
   ```ts
   async function withFallback<T>(fn: (rpc: string) => Promise<T>): Promise<T> {
     try { return await fn(process.env.SOROBAN_RPC_URL!); }
     catch (e) { return await fn(process.env.SOROBAN_RPC_FALLBACK!); }
   }
   ```

### Day 28 — Monitoring

1. Sentry: add `@sentry/nextjs`, configure DSN
2. Grafana Cloud: free tier, add dashboards for:
   - RPC requests/sec, latency p50/p95/p99, error rate
   - Mercury indexer lag (poll Mercury status endpoint)
   - Vercel edge cache hit rate (Vercel Analytics)
3. Alerts (Slack webhook or PagerDuty):
   - RPC #1 down 2+ min → high
   - Both RPCs down → critical
   - Mercury lag >60s → medium
   - JS error rate >1% → medium

### Day 29 — Load test

```bash
# Using k6
cat > load-test.js <<'EOF'
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    snapshot: { executor: 'constant-vus', vus: 200, duration: '5m', exec: 'snapshot' },
    account:  { executor: 'constant-vus', vus: 800, duration: '5m', exec: 'account' },
  },
};

const ACCOUNTS = [/* 100 testnet smart-account addresses */];

export function snapshot() {
  const r = http.get('https://prod.vanna/api/snapshot');
  check(r, { ok: (r) => r.status === 200 });
}
export function account() {
  const addr = ACCOUNTS[Math.floor(Math.random() * ACCOUNTS.length)];
  const r = http.get(`https://prod.vanna/api/account/${addr}`);
  check(r, { ok: (r) => r.status === 200 });
}
EOF

k6 run load-test.js
```

Targets:
- 1000 VUs sustained 5 min, no errors
- p99 latency < 200 ms
- RPC requests during test < 500/min (proves edge cache works)

### Day 30 — Runbooks + on-call

Write 4 short runbooks in `Stellar_backend/docs/runbooks/`:

1. `rpc-failover.md` — when primary RPC dies
2. `mercury-outage.md` — frontend graceful degradation, queue Hubble fallbacks
3. `compressor-redeploy.md` — versioning view contract without breaking FE
4. `hot-fix-rollback.md` — Vercel revert + edge cache purge

Define on-call rotation in Slack / PagerDuty.

**Sprint 6 Done When:**
- [ ] 2× Soroban RPC + 1× Horizon in production
- [ ] Sentry + Grafana dashboards live
- [ ] Alerts firing correctly
- [ ] k6 load test 1k VUs / 5min passes
- [ ] All 4 runbooks written
- [ ] On-call rotation defined

---

## What Stays In Sprint 0 (do before starting)

These are pre-requisites; do them before Day 1:

- [ ] Confirm `OracleContract` is deployed to the network you're targeting
- [ ] List all contract addresses in `Stellar_backend/.env.local`:
  ```
  NEXT_PUBLIC_REGISTRY_ADDR=...
  NEXT_PUBLIC_ACCOUNT_MANAGER_ADDR=...
  NEXT_PUBLIC_ORACLE_CONTRACT=...
  NEXT_PUBLIC_LENDING_POOL_USDC=...
  NEXT_PUBLIC_LENDING_POOL_XLM=...
  NEXT_PUBLIC_LENDING_POOL_EURC=...
  NEXT_PUBLIC_LENDING_POOL_AQUARIUS_USDC=...
  NEXT_PUBLIC_LENDING_POOL_SOROSWAP_USDC=...
  ```
- [ ] Get Mercury Pro account (sign up + payment ready)
- [ ] Get Validation Cloud / Blockdaemon trial account for RPC
- [ ] Get GCP project for BigQuery / Hubble
- [ ] Vercel Pro account
- [ ] Sentry team account

---

## Definition Of Done — Whole Project

- [ ] Zero `setInterval` data-fetching in repo
- [ ] Zero CoinGecko reference
- [ ] One `simulateTransaction` per page render (verified via DevTools)
- [ ] Edge cache absorbs 99% of repeat global reads
- [ ] Mercury indexes all 12 event types live
- [ ] Hubble powers `/stats` charts at $0/mo
- [ ] 2× RPC HA + 1× Horizon HA in production
- [ ] Grafana + Sentry + alerts live, runbooks written
- [ ] k6 load test 1k VUs passes
- [ ] On-call rotation defined
- [ ] Documented in `README.md`

---

## After Mainnet — What Comes Next

Stack above is good to **~50k DAU**. Beyond that:

- **Add Redis** (Upstash / Vercel KV) for per-user cache → collapse repeated `/api/account/[addr]` reads
- **WS gateway** — only if you launch perp / orderbook needing <1s latency
- **Migrate Mercury → SubQuery self-host** — only if Mercury Enterprise tier becomes >$2k/mo OR OSS narrative needed for fundraising

None of those are needed before mainnet launch. Ship this plan first.

---

## Cost Summary

| Phase | One-time eng | Monthly recurring |
| ----- | ------------ | ----------------- |
| S1 (1 wk FE)         | ~$2,000  | $0 |
| S2 (2 wk FE+Soroban) | ~$5,000  | $50 (testnet RPC) |
| S3 (3 days FE)       | ~$1,000  | included in Vercel |
| S4 (1 wk FE)         | ~$1,500  | $200–400 (Mercury) |
| S5 (3 days FE)       | ~$1,000  | $0 (Hubble free) |
| S6 (1 wk DevOps+FE)  | ~$2,500  | $1,200–1,600 (RPC + Horizon + monitoring) |
| **TOTAL**            | **~$13,000** | **$1,500–2,000/mo at 10k DAU** |

---

## TL;DR — Day 1 Action Items

If starting tomorrow:

1. Pre-reqs: book Mercury Pro, Validation Cloud trial, Vercel Pro, GCP project
2. Pull all contract addresses into `.env.local`
3. Day 1 of Sprint 1: build `LedgerSubscriberProvider` (full code above)
4. End of Day 5: zero `setInterval` in repo
5. End of Week 6: 10k-DAU-ready stack in production

---

*— end of implementation plan —*
