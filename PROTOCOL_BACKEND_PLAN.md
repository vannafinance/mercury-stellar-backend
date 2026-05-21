# Vanna V1 Protocol — Tailored Backend Architecture Plan

> Built after reading the actual contract code at
> `C:\Users\dell\Downloads\Protocol_V1_Soroban (1)\Protocol_V1_Soroban\contracts\`.
>
> Companion to [BACKEND_RESEARCH.md](BACKEND_RESEARCH.md) (which surveys Derive,
> Gearbox, SushiSwap). This document narrows that survey down to **the exact
> combination** that fits *your* protocol, with concrete view-function and
> hook signatures you can lift into a sprint plan.

---

## TL;DR — The Right Combination For You

Forget the verbatim "WebSocket + subgraph + Multicall3" copy from EVM-land. Your
protocol is a **smart-account-based leverage / lending** system (architecturally
closer to Gearbox V3 than to Derive). Given Soroban's primitives + what your
contracts already expose, the optimal triad is:

| EVM equivalent     | Vanna's actual answer                                                    | Why                                                  |
| ------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| Multicall3         | **`ProtocolViewContract` (new compressor view contract)**                | Soroban simulation is free → free batching, better than Multicall3 |
| TheGraph subgraph  | **Mercury** indexing your existing Soroban events                        | You already emit clean, structured events            |
| WebSocket          | **Horizon `streamLedgers()` SSE + `getEvents` polling** → React Query invalidation | Stellar SDK already has this; zero new infra         |
| Off-chain oracle   | **Drop CoinGecko entirely — read your own `OracleContract` (which wraps Reflector)** | Already deployed. CoinGecko is dead weight.          |

**The single biggest realisation reading your code:** you have already done 60 %
of the work and don't know it.

- ✅ `OracleContract` already wraps Reflector → CoinGecko is removable today.
- ✅ `RiskEngineContract::is_borrow_allowed` already builds a `Map<Symbol, u128>`
  price cache and computes total_balance/total_debt — that's a compressor in
  embryo. Just needs to be exposed as a view function.
- ✅ Every state-changing function emits a structured event with timestamp →
  perfect for indexing into Mercury.
- ✅ `RegistryContract` is already a single discovery surface for every pool /
  oracle / risk-engine / external-protocol address.

What's missing is **one** new view contract + **one** event-driven indexer +
**one** ledger-stream subscriber on the frontend. That's it. Three small
pieces, not a complete rewrite.

---

## 1. What Your Contracts Actually Look Like

### 1.1 Contract topology

```
                    ┌────────────────────────┐
                    │   RegistryContract     │  ← single source-of-truth for addresses
                    │  (get_lendingpool_*    │
                    │   get_oracle_*         │
                    │   get_risk_engine_*)   │
                    └───────────┬────────────┘
                                │ everyone reads addresses from here
        ┌───────────────────────┼───────────────────────────┐
        │                       │                           │
┌───────▼──────────┐   ┌────────▼──────────┐    ┌───────────▼─────────┐
│ AccountManager   │   │  RiskEngine       │    │  OracleContract     │
│  create_account  │   │  is_borrow_allowed│    │  get_price_latest   │
│  deposit         │──▶│  is_withdraw_..   │───▶│  → Reflector        │
│  withdraw        │   │  is_account_..    │    │  (CCYOZJ.../CAFJZQ..)│
│  borrow / repay  │   │  get_total_balance│    └─────────────────────┘
│  liquidate       │   │  get_total_borrows│
│  execute         │   └───────────────────┘
└───────┬──────────┘
        │ deploys + orchestrates
        ▼
┌────────────────────────┐         ┌──────────────────────┐
│  SmartAccountContract  │ ──────▶ │ External: Blend Pool │
│  (one per user)        │ ──────▶ │ External: Aquarius   │
│  collateral_balances   │ ──────▶ │ External: Soroswap   │
│  borrowed_tokens_list  │         └──────────────────────┘
│  has_debt              │
│  is_account_active     │
│  execute() (router)    │
└────────────────────────┘

┌──────────────────────────────────┐  ┌─────────────────────┐
│ LendingProtocol{XLM,USDC,EURC}   │  │ V{XLM,USDC,EURC}    │
│  + aquarius_usdc, soroswap_usdc  │  │ TokenContracts      │
│  lend_to / collect_from          │  │ (lender receipts)   │
│  get_borrow_balance              │  └─────────────────────┘
│  get_total_liquidity_in_pool     │
│  get_rate_factor                 │  ┌─────────────────────┐
│  get_total_v*_minted/burnt       │  │ TrackingTokenContract│
└──────────────────────────────────┘  │ (Blend bToken track)│
                                      └─────────────────────┘
```

### 1.2 Events you already emit (the indexer's source data)

From grepping `env.events().publish` across all contracts:

| Event topic                       | Emitter                | Payload                                                                       |
| --------------------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `Smart_account_creation`          | AccountManager         | `AccountCreationEvent { smart_account, creation_time }` keyed by trader        |
| `Smart_Account_Closed`            | AccountManager         | `AccountDeletionEvent { smart_account, deletion_time }` keyed by trader        |
| `Smart_Account_Activated`         | SmartAccount           | `SmartAccountActivationEvent { margin_account, activated_time }`               |
| `Smart_Account_Deactivated`       | SmartAccount           | `SmartAccountDeactivationEvent { margin_account, deactivate_time }`            |
| `Trader_Borrow`                   | AccountManager         | `token_symbol` keyed by smart_account                                          |
| `Trader_Repay_Event`              | AccountManager         | `TraderRepayEvent { smart_account, token_amount, timestamp, token_symbol }`    |
| `Trader_Liquidate_Event`          | AccountManager         | `TraderLiquidateEvent { smart_account, timestamp }`                            |
| `Trader_SettleAccount_Event`      | AccountManager         | `TraderSettleAccountEvent { smart_account, timestamp }`                        |
| `deposit_event`                   | LendingPool{USDC,XLM,EURC} | `LendingDepositEvent { lender, amount, timestamp, asset_symbol }`         |
| `withdraw_event`                  | LendingPool{USDC,XLM,EURC} | `LendingWithdrawEvent { lender, vtoken_amount, timestamp, asset_symbol }` |
| `mint_event`                      | LendingPool            | `LendingTokenMintEvent { lender, token_amount, timestamp, token_symbol }`     |
| `burn_event`                      | LendingPool            | `LendingTokenBurnEvent { lender, token_amount, timestamp, token_symbol }`     |

**This is gold.** Every user action you'd want to chart, leaderboard, or
notify on is already a structured event with a topic, indexed key, and
typed payload. An indexer needs almost zero schema work — it just decodes the
existing Soroban event payloads.

### 1.3 View functions you already expose (and which are duplicated client-side today)

#### RegistryContract

`get_lendingpool_{xlm,usdc,eurc,aquarius_usdc,soroswap_usdc}`,
`get_risk_engine_address`, `get_rate_model_address`,
`get_oracle_contract_address`, `get_xlm_contract_adddress`,
`get_usdc_contract_address`, `get_eurc_contract_address`,
`get_blend_pool_address`, `get_aquarius_router_address`,
`get_soroswap_router_address`, `has_*` variants for everything optional,
`get_aquarius_usdc_addr`, `get_soroswap_usdc_addr`, `get_aquarius_pool_index`,
`get_tracking_token_contract_addr`.

#### RiskEngineContract

```rust
is_borrow_allowed(symbol, borrow_amount_wad, margin_account) -> bool
is_withdraw_allowed(symbol, withdraw_amount_wad, margin_account) -> bool
is_account_healthy(total_balance_wad, total_debt_wad) -> bool
get_current_total_balance(margin_account) -> U256   // sum of collateral × oracle price
get_current_total_borrows(margin_account) -> U256   // sum of debt × oracle price
```

The internal `cache_price` function (line 404) already proves the pattern:
**fetch each unique symbol from oracle exactly once, cache, multiply.** This
is exactly the compressor pattern. It's just not exposed.

#### LendingPool{USDC,XLM,EURC}

```rust
get_user_borrow_shares(trader)   -> U256
get_borrow_balance(trader)       -> U256       // user-visible debt incl. interest
get_total_borrow_shares()        -> U256
get_borrows()                    -> U256       // pool-wide
get_rate_factor()                -> U256       // for APR computation
get_total_liquidity_in_pool()    -> U256
get_last_updated_time()          -> u64
get_current_total_vusdc_balance()-> U256       // (and v_xlm / v_eurc analogues)
get_total_v*_minted/burnt()      -> U256
get_lenders_usdc()               -> Vec<Address>  // ⚠️ unbounded — see §5
is_*_pool_initialised()          -> bool
```

#### SmartAccountContract

```rust
get_all_collateral_tokens()           -> Vec<Symbol>
get_all_borrowed_tokens()             -> Vec<Symbol>
get_collateral_token_balance(sym)     -> U256
get_borrowed_token_debt(sym)          -> U256   // delegates to LendingPool
has_debt()                            -> bool
is_account_active()                   -> bool
```

#### OracleContract

```rust
get_price_latest(symbol) -> (price: u128, decimals: u32)   // wraps Reflector
```

### 1.4 What the frontend has to do today vs. what it should do

For a single dashboard render the frontend currently has to:

```
1. Registry.get_oracle_contract_address           1 sim
2. Registry.get_risk_engine_address               1 sim
3. Registry.get_lendingpool_xlm                   1 sim
4. Registry.get_lendingpool_usdc                  1 sim
5. Registry.get_lendingpool_eurc                  1 sim
6. Registry.get_lendingpool_aquarius_usdc         1 sim
7. Registry.get_lendingpool_soroswap_usdc         1 sim
8. SmartAccount.get_all_collateral_tokens         1 sim
9. SmartAccount.get_all_borrowed_tokens           1 sim
10-13. SmartAccount.get_collateral_token_balance × N (per asset)
14-17. SmartAccount.get_borrowed_token_debt × M  (per borrowed asset)
18-N. Oracle.get_price_latest(symbol) × K        (per unique symbol)
N+1. RiskEngine.get_current_total_balance         1 sim
N+2. RiskEngine.get_current_total_borrows         1 sim
N+3. LendingPool*.get_total_liquidity_in_pool × P (per pool, for APR card)
N+4. LendingPool*.get_rate_factor × P
…
```

That's easily **20–40 simulations per dashboard render** today. Section 3
proposes collapsing all of it to **2–3** with a compressor.

---

## 2. The Three-Layer Combination, Spelled Out

### Layer A — Reads (replaces "Multicall3" + RPC polling)

**Add `ProtocolViewContract`** — a single read-only Soroban contract whose
entire job is to bundle every read your frontend needs. Each function does
its own internal calls to Registry, RiskEngine, Oracle, LendingPools,
SmartAccount — but the *frontend* only sees one `simulateTransaction`.

This is exactly Gearbox V3's `CreditAccountCompressor` pattern, adapted.

**Why a new contract instead of adding methods to RiskEngine?**

- Keep RiskEngine focused on *enforcement* (used inside `borrow`/`withdraw`).
  Adding view-only aggregation muddies its responsibility.
- New contract can be redeployed without touching audited risk logic.
- Lets you ship view-only schema changes (add new fields) without bumping
  the risk-engine version every release.

You can also just *add* the methods to RiskEngine if you want one fewer
contract to deploy — both work. Recommend new contract for cleaner
separation, but it's a judgement call.

### Layer B — Live updates (replaces "WebSocket")

Two streams running together at the app shell level:

1. **`Server.streamLedgers({ cursor: 'now' })`** from the Stellar SDK Horizon
   client → fires roughly every 5 s on testnet ledger close.
2. **Soroban RPC `getEvents`** polled at ~5 s with the latest ledger cursor,
   filtered to *your* contract addresses + topics from §1.2.

On every event matching one of your topics → call `qc.invalidateQueries`
on the relevant React Query key. That gives you push-style UX without a
custom gateway.

You only need a real WebSocket gateway if you later add an orderbook product
where ledger cadence (5 s) is too slow. For lending/leverage UX, ledger
cadence is fine — same as Aave / Gearbox / Compound on EVM with 12-s blocks.

### Layer C — History / analytics (replaces "Subgraph")

**Mercury** ([mercurydata.app](https://mercurydata.app)) — Stellar's native
indexer. Plug your contract addresses + event topics in, get a Postgres-
backed GraphQL endpoint. Use it **only** for:

- Trader history (borrows / repays / liquidations over time)
- Pool TVL charts
- Leaderboards (most-borrowed assets, top traders by P&L)
- Notification queue (your liquidator bot can listen here too)

**Never** use it for live state — live state is always RPC + view contract.
Subgraphs/Mercury have a few-ledger lag and you cannot trust them on the
hot path. Gearbox enforces this rule strictly; you should too.

---

## 3. The `ProtocolViewContract` — Concrete Sketch

A new Soroban contract under `contracts/ProtocolViewContract/` with these
view functions. **All return-types use `#[contracttype]` structs** so XDR
decode on the frontend stays trivial.

### 3.1 Types

```rust
// contracts/ProtocolViewContract/src/types.rs
use soroban_sdk::{contracttype, Address, Symbol, U256, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenBalanceUsd {
    pub symbol: Symbol,
    pub balance_wad: U256,        // raw WAD-scaled balance
    pub price_wad: U256,          // oracle price (WAD)
    pub usd_value_wad: U256,      // balance × price (WAD)
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountView {
    pub margin_account: Address,
    pub trader: Address,
    pub is_active: bool,
    pub has_debt: bool,
    pub collaterals: Vec<TokenBalanceUsd>,
    pub borrows:     Vec<TokenBalanceUsd>,
    pub total_collateral_usd_wad: U256,
    pub total_borrows_usd_wad:    U256,
    pub health_factor_wad:        U256,   // collateral/debt × WAD
    pub is_healthy:               bool,
    pub timestamp:                u64,    // ledger timestamp at read
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolStats {
    pub asset_symbol: Symbol,
    pub pool_address: Address,
    pub total_liquidity_wad: U256,
    pub total_borrows_wad:   U256,
    pub utilization_wad:     U256,        // borrows / liquidity
    pub borrow_apr_wad:      U256,        // from rate model
    pub supply_apr_wad:      U256,        // borrow_apr × utilization × (1 - reserve_factor)
    pub total_vtokens_wad:   U256,
    pub last_updated:        u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolSnapshot {
    pub pools: Vec<PoolStats>,
    pub prices: Vec<TokenPrice>,          // every supported asset price
    pub block_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenPrice {
    pub symbol: Symbol,
    pub price_wad: U256,
    pub decimals: u32,
}
```

### 3.2 The four view functions you actually need

```rust
// contracts/ProtocolViewContract/src/view.rs
#[contractimpl]
impl ProtocolViewContract {
    /// One-shot dashboard for a single margin account.
    /// Replaces ~20 separate sims with 1.
    pub fn get_account_view(env: Env, margin_account: Address) -> AccountView {
        let registry  = registry_client(&env);
        let oracle    = oracle_client(&env, &registry);
        let smart_acc = smart_account_client(&env, &margin_account);

        let collateral_syms = smart_acc.get_all_collateral_tokens();
        let borrow_syms     = smart_acc.get_all_borrowed_tokens();

        // Single price-cache pass — exactly the pattern RiskEngine already uses
        let mut prices: Map<Symbol, U256> = Map::new(&env);
        for sym in collateral_syms.iter().chain(borrow_syms.iter()) {
            let canon = canonical_price_symbol(&env, &sym);
            if prices.get(canon.clone()).is_none() {
                let (p, dec) = oracle.get_price_latest(&canon);
                let wad = scale_price_to_wad(p, dec);
                prices.set(canon, U256::from_u128(&env, wad));
            }
        }

        let mut collaterals = Vec::new(&env);
        let mut total_coll_usd = U256::from_u128(&env, 0);
        for sym in collateral_syms.iter() {
            let bal = resolve_collateral_balance_wad(&env, &smart_acc, &registry, &sym);
            let price = prices.get(canonical_price_symbol(&env, &sym)).unwrap_or(U256::from_u128(&env, 0));
            let usd = mul_wad_down(&env, bal.clone(), price.clone());
            total_coll_usd = total_coll_usd.add(&usd);
            collaterals.push_back(TokenBalanceUsd { symbol: sym, balance_wad: bal, price_wad: price, usd_value_wad: usd });
        }

        let mut borrows = Vec::new(&env);
        let mut total_borrows_usd = U256::from_u128(&env, 0);
        for sym in borrow_syms.iter() {
            let debt = get_debt_direct(&env, &registry, &sym, &margin_account);
            let price = prices.get(canonical_price_symbol(&env, &sym)).unwrap_or(U256::from_u128(&env, 0));
            let usd = mul_wad_down(&env, debt.clone(), price.clone());
            total_borrows_usd = total_borrows_usd.add(&usd);
            borrows.push_back(TokenBalanceUsd { symbol: sym, balance_wad: debt, price_wad: price, usd_value_wad: usd });
        }

        let hf = if total_borrows_usd == U256::from_u128(&env, 0) {
            U256::from_u128(&env, u128::MAX)
        } else {
            total_coll_usd.mul(&U256::from_u128(&env, WAD_U128)).div(&total_borrows_usd)
        };

        AccountView {
            margin_account: margin_account.clone(),
            trader: get_trader_address(&env, &registry, &margin_account),
            is_active: smart_acc.is_account_active(),
            has_debt: smart_acc.has_debt(),
            collaterals,
            borrows,
            total_collateral_usd_wad: total_coll_usd,
            total_borrows_usd_wad:    total_borrows_usd,
            health_factor_wad:        hf,
            is_healthy:               hf > U256::from_u128(&env, BALANCE_TO_BORROW_THRESHOLD),
            timestamp:                env.ledger().timestamp(),
        }
    }

    /// All pool stats in one call. Drives Earn page + Farm page.
    pub fn get_protocol_snapshot(env: Env) -> ProtocolSnapshot {
        let registry = registry_client(&env);
        let oracle   = oracle_client(&env, &registry);

        let supported: Vec<(Symbol, Address)> = supported_pools(&env, &registry);
        let mut pools = Vec::new(&env);
        for (sym, pool_addr) in supported.iter() {
            pools.push_back(load_pool_stats(&env, &registry, &sym, &pool_addr));
        }

        let mut prices = Vec::new(&env);
        for sym in [XLM, USDC, EURC].iter() {
            let (p, dec) = oracle.get_price_latest(sym);
            prices.push_back(TokenPrice { symbol: sym.clone(), price_wad: U256::from_u128(&env, scale_price_to_wad(p, dec)), decimals: dec });
        }

        ProtocolSnapshot { pools, prices, block_timestamp: env.ledger().timestamp() }
    }

    /// Combined view: pools + the user's account in one call.
    /// Drives the main app shell on every ledger close.
    pub fn get_user_full_view(env: Env, margin_account: Address) -> (AccountView, ProtocolSnapshot) {
        (Self::get_account_view(env.clone(), margin_account), Self::get_protocol_snapshot(env))
    }

    /// Page-of-traders for leaderboard / liquidator scanning.
    /// Returns `(account_view, ...)` for a slice of margin accounts.
    pub fn get_accounts_view_batch(env: Env, accounts: Vec<Address>) -> Vec<AccountView> {
        let mut out = Vec::new(&env);
        for a in accounts.iter() {
            out.push_back(Self::get_account_view(env.clone(), a));
        }
        out
    }
}
```

**What this collapses, in numbers:**

| Page                | Before (sims) | After (sims) |
| ------------------- | ------------- | ------------ |
| Margin dashboard    | 20–30         | **1**        |
| Earn page           | 8–12          | **1**        |
| Farm page           | 6–10          | **1**        |
| Liquidator scan (N accts) | 30 × N | **1** (batch) |

Soroban simulation is **free** unless you submit, so this scales linearly
in the number of users with constant per-user network cost.

### 3.3 Frontend hook against the compressor

```ts
// hooks/use-account-view.ts
import { useQuery } from "@tanstack/react-query";
import { useLedgerTick } from "@/contexts/ledger-subscriber";
import { sorobanRpc } from "@/lib/stellar-utils";
import { decodeAccountView, decodeProtocolSnapshot } from "@/lib/view-codec";

export function useUserFullView(marginAccount?: string) {
  const ledger = useLedgerTick();   // increments on each new ledger close

  return useQuery({
    queryKey: ["userFullView", marginAccount, ledger],
    queryFn: async () => {
      if (!marginAccount) return null;
      const sim = await sorobanRpc.simulateTransaction(
        buildContractCall(VIEW_CONTRACT_ADDR, "get_user_full_view", [marginAccount])
      );
      const [account, snapshot] = decodeUserFullView(sim.result);
      return { account, snapshot };
    },
    enabled: !!marginAccount,
    staleTime: 4_000,        // <ledger tick → reuse
  });
}
```

Every component (Dashboard, Earn, Farm) reads from this **one** hook with
specific selectors. No more `usePoolData` + `useUserPositions` +
`useBlendPoolStats` + `useSoroswapAllPoolStats` + price context. One source
of truth, refreshed on every ledger close.

---

## 4. The Mercury Indexer Setup

### 4.1 What you index

From §1.2 — you already emit everything an indexer needs:

| Mercury entity        | Sourced from event                                       |
| --------------------- | -------------------------------------------------------- |
| `Account`             | `Smart_account_creation`, `Smart_Account_Closed`         |
| `AccountActivation`   | `Smart_Account_Activated`, `Smart_Account_Deactivated`   |
| `Borrow`              | `Trader_Borrow`                                          |
| `Repay`               | `Trader_Repay_Event`                                     |
| `Liquidation`         | `Trader_Liquidate_Event`                                 |
| `Settle`              | `Trader_SettleAccount_Event`                             |
| `LenderDeposit`       | `deposit_event` (per pool)                               |
| `LenderWithdraw`      | `withdraw_event`                                         |
| `VTokenMint`          | `mint_event`                                             |
| `VTokenBurn`          | `burn_event`                                             |

Mercury exposes these as GraphQL types automatically once you point it at
the contract addresses. No custom WAS/handler code is required for
read-the-event-as-row indexing — the structured `#[contracttype]` payloads
deserialise cleanly.

### 4.2 What the frontend uses Mercury for

```ts
// hooks/use-trader-history.ts (replaces hooks/use-margin.ts)
export function useTraderHistory(marginAccount?: string) {
  return useQuery({
    queryKey: ["mercury", "history", marginAccount],
    queryFn: () => mercuryClient.query(`
      query History($acc: String!) {
        borrows: traderBorrows(where: {smartAccount: $acc}, orderBy: timestamp_DESC, first: 100) { ... }
        repays:  traderRepays (where: {smartAccount: $acc}, orderBy: timestamp_DESC, first: 100) { ... }
        liquidations: traderLiquidations(where: {smartAccount: $acc}) { ... }
      }
    `, { acc: marginAccount }),
    enabled: !!marginAccount,
    staleTime: 30_000,        // history doesn't move fast
  });
}
```

Use Mercury for: **history, leaderboards, charts, search, notifications.**
Never for live position state.

### 4.3 What replaces the in-contract `get_lenders_usdc()` Vec

`LendingPoolUSDC::get_lenders_usdc()` returns a `Vec<Address>` of *all*
lenders — that grows unboundedly and is going to become a gas-bomb / TTL
nightmare at scale. **Migrate this query to Mercury.** The frontend should
ask Mercury for "addresses with non-zero vUSDC balance" instead of reading
the `Vec` from chain. Same answer, no on-chain unbounded growth.

This is a real architectural debt your contracts have today, and Mercury
fixes it without a contract migration.

---

## 5. The Ledger-Tick Subscriber (Vanna's "WebSocket")

```tsx
// contexts/ledger-subscriber.tsx
"use client";
import React, { createContext, useContext, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Horizon, rpc as sorobanRpc } from "@stellar/stellar-sdk";

const LedgerCtx = createContext<{ tick: number; latestLedger: number }>({ tick: 0, latestLedger: 0 });

export function useLedgerTick() {
  return useContext(LedgerCtx).tick;
}

export function LedgerSubscriberProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [tick, setTick] = useState(0);
  const [latestLedger, setLatestLedger] = useState(0);
  const horizon = new Horizon.Server(process.env.NEXT_PUBLIC_HORIZON_URL!);
  const soroban = new sorobanRpc.Server(process.env.NEXT_PUBLIC_SOROBAN_RPC_URL!);

  // Stream A — Horizon ledger close → tick + invalidate
  useEffect(() => {
    const close = horizon.ledgers().cursor("now").stream({
      onmessage: () => {
        setTick((t) => t + 1);
        qc.invalidateQueries({ queryKey: ["userFullView"] });
        qc.invalidateQueries({ queryKey: ["protocolSnapshot"] });
      },
      onerror: (e) => console.warn("[ledger] stream err", e),
    });
    return () => close();
  }, [qc]);

  // Stream B — Soroban event poll for our contract topics
  useEffect(() => {
    const POLL_MS = 5_000;
    let cursor: string | undefined;
    let stop = false;

    async function loop() {
      while (!stop) {
        try {
          const resp = await soroban.getEvents({
            startLedger: cursor ? undefined : (await soroban.getLatestLedger()).sequence - 5,
            cursor,
            filters: [{
              type: "contract",
              contractIds: [
                process.env.NEXT_PUBLIC_ACCOUNT_MANAGER!,
                process.env.NEXT_PUBLIC_LENDING_POOL_USDC!,
                process.env.NEXT_PUBLIC_LENDING_POOL_XLM!,
                process.env.NEXT_PUBLIC_LENDING_POOL_EURC!,
              ],
            }],
            limit: 100,
          });
          for (const ev of resp.events) {
            handleEvent(ev, qc);
            cursor = ev.pagingToken;
          }
        } catch (e) { console.warn("[soroban events]", e); }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    }
    loop();
    return () => { stop = true; };
  }, [qc]);

  return <LedgerCtx.Provider value={{ tick, latestLedger }}>{children}</LedgerCtx.Provider>;
}

function handleEvent(ev: any, qc: ReturnType<typeof useQueryClient>) {
  const topic0 = ev.topic[0]?.toString();
  switch (topic0) {
    case "Trader_Borrow":
    case "Trader_Repay_Event":
    case "Trader_Liquidate_Event":
    case "Trader_SettleAccount_Event":
      qc.invalidateQueries({ queryKey: ["userFullView"] });
      qc.invalidateQueries({ queryKey: ["mercury", "history"] });
      break;
    case "deposit_event":
    case "withdraw_event":
    case "mint_event":
    case "burn_event":
      qc.invalidateQueries({ queryKey: ["userFullView"] });
      qc.invalidateQueries({ queryKey: ["protocolSnapshot"] });
      break;
    case "Smart_account_creation":
    case "Smart_Account_Closed":
      qc.invalidateQueries({ queryKey: ["accounts"] });
      break;
  }
}
```

Drop `<LedgerSubscriberProvider>` in `app/layout.tsx`. Every existing hook
loses its `refetchInterval` and gains a dependency on `useLedgerTick()` (or
nothing — invalidation alone is enough). User sees instant refresh on every
state change.

---

## 6. What This Means For The Existing Frontend

### 6.1 Stuff to delete

- [contexts/price-context.tsx](contexts/price-context.tsx) — entire file. Read prices from `OracleContract` via the compressor.
- [lib/prices.ts](lib/prices.ts) — entire file. Same reason.
- The `setInterval` at [app/page.tsx:111](app/page.tsx#L111) — replaced by ledger subscriber.
- All `refetchInterval: 30_000 / 60_000 / 10_000` flags in `hooks/use-*.ts` — replaced by ledger-tick invalidation.
- The localStorage-based history merge in [hooks/use-margin.ts](hooks/use-margin.ts) — replaced by Mercury.
- The CoinGecko `fetch` call in `lib/prices.ts` — gone.
- [lib/hooks/useSmartPolling.ts](lib/hooks/useSmartPolling.ts) — keep only if you need a fallback for non-on-chain data; otherwise delete.

### 6.2 Stuff to add

- `contracts/ProtocolViewContract/` — new Soroban contract (§3).
- `contexts/ledger-subscriber.tsx` — new (§5).
- `lib/view-codec.ts` — XDR → TS struct decoders for the compressor types.
- `lib/mercury-client.ts` — Mercury GraphQL client.
- `hooks/use-account-view.ts`, `hooks/use-protocol-snapshot.ts`, `hooks/use-trader-history.ts` — new hooks against compressor + Mercury.

### 6.3 Stuff to refactor

- Every existing `usePoolData`, `useUserPositions`, `useBlendPoolStats`,
  `useSoroswapPoolStats`, `useUserBlendPositions`, etc. — collapse into
  selectors over `useUserFullView` + `useProtocolSnapshot`.
- `useMutation` for every on-chain write (deposit, withdraw, borrow, repay,
  external execute) — `onSuccess: () => qc.invalidateQueries(["userFullView"])`.
  Stop bumping `refreshKey` in `blend-store`.
- Drop dual-write (RQ + Zustand). Server state lives in RQ. Zustand only
  for UI mode, selected pool, form drafts.

---

## 7. Sequenced Plan (Realistic Estimates)

### Sprint 1 (1 week, 1 engineer) — Frontend rebuild against existing contracts

Without writing new Soroban code yet:

1. Add `LedgerSubscriberProvider` (§5).
2. Strip CoinGecko + price context. Replace with on-chain `OracleContract.get_price_latest` reads (one sim per asset, batched via `Promise.all`).
3. Remove every `refetchInterval`. Make hooks ledger-tick driven.
4. Convert mutations to `useMutation` + `qc.invalidateQueries(["userFullView"])`.
5. Drop `refreshKey` machinery.

This alone gives ~5× perceived UX improvement and cuts CoinGecko dependency.

### Sprint 2 (2 weeks, 1 engineer + Soroban dev) — Compressor contract

1. Build `ProtocolViewContract` (§3).
2. Deploy to testnet.
3. Add `get_account_view` / `get_protocol_snapshot` codecs in TS.
4. Migrate dashboard / earn / farm hooks to call the compressor.

After this lands, your "20 sims per page" becomes **1 sim per page**. RPC
load drops by ~20× and you're now running the same shape Gearbox V3 runs.

### Sprint 3 (2 weeks, 1 engineer) — Mercury indexer

1. Sign up Mercury, point at your testnet contract addresses.
2. Define entities matching §1.2.
3. Replace `useMarginHistory` with Mercury query.
4. Replace `LendingPoolUSDC.get_lenders_usdc()` chain read with Mercury.
5. Add basic charts (TVL, borrow volume) sourced from Mercury.

### Sprint 4+ (only if needed) — Custom WS gateway

Skip unless you add a sub-5-s-latency product (orderbook, perps, options).
For lending/leverage, the §5 ledger-tick + event-poll combo is sufficient.

---

## 8. Why This Combination, And Not Something Else

A few alternatives I considered and why they're worse for *this* protocol:

**"Just use Multicall3-equivalent generic batching"**
There is no good Soroban analogue, and even if there were, generic batching
is *worse* than a purpose-built compressor. The compressor can deduplicate
oracle reads, share intermediate computation (canonical price symbol
mapping, blend-tracking-token resolution), and return decoded structs
instead of raw byte arrays. Same one-sim cost, much less frontend decoding.

**"Build the WS gateway first, it's flashier"**
Engineering cost (4–8 weeks) doesn't pay back until you have a sub-5-s-
latency product. Today your slowest UI feels slow because of *polling
intervals*, not ledger time. Fix the polling first; the gateway becomes
optional.

**"Index everything with a custom Postgres + worker; skip Mercury"**
Possible, more flexible long-term, but adds an ops burden (DB hosting,
backfills, schema migrations) you don't need at current scale. Mercury is
~free to start, has 90 % of what a leverage protocol needs, and you can
migrate off later if you outgrow it.

**"Push prices through your own backend so you can layer Pyth + Reflector"**
You'd lose the "everything in one simulation" property the compressor
gives you. If you really want price diversity, do it *inside* the on-chain
`OracleContract` (e.g., median of multiple oracles), not in a backend
between user and chain.

---

## 9. One-paragraph Verdict

Your protocol is two contracts away from being a textbook Gearbox-style
"no backend on the hot path" architecture: a `ProtocolViewContract` to
collapse reads + a Mercury indexer to handle history. Add a
`LedgerSubscriberProvider` on the frontend and you have realtime feel
without any custom WebSocket infrastructure. CoinGecko goes away because
your `OracleContract` already wraps Reflector. The big idea is: you
don't need WebSocket + subgraph + Multicall3 verbatim — you need their
**functions**, and Soroban + your existing event/oracle plumbing gives you
better-shaped versions of all three for less code.

---

*— end of plan —*
