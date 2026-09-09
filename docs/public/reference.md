# Tool & Asset Reference

This page is the technical index for the [MCP Server Guide](./mcp-server-guide.md): the composite tool surface, the domains they cover, and the assets/protocols Vanna supports. It reflects the current **testnet** deployment.

## Composite tools (`composites` mode — 14 tools)

Each tool takes an `action` parameter plus that action's own arguments.

| Tool | Actions | Domain |
|---|---|---|
| `vanna_oracle` | `get_price`, `get_prices_batch` | Price feed |
| `vanna_protocol_info` | `list_addresses`, `collateral_config` | Registry / live collateral allowlist |
| `vanna_account` | `open`, `close`, `resolve`, `list_inactive`, `list_smart_accounts`, `register`, `unregister` | Margin account lifecycle |
| `vanna_margin_status` | `health`, `collateral`, `debt`, `max_borrow` | Margin reads |
| `vanna_margin_trade` | `can_withdraw`, `deposit`, `withdraw`, `can_borrow`, `borrow`, `deposit_and_borrow`, `deposit_and_borrow_cross`, `repay`, `settle`, `liquidate` | Margin writes |
| `vanna_earn_market` | `pool_stats`, `exchange_rate` | Earn pool data |
| `vanna_earn_position` | `balance` | vToken balance |
| `vanna_earn_write` | `lend`, `redeem` | Earn deposit / withdraw |
| `vanna_farm_overview` | `overview` | Aggregated farm portfolio |
| `vanna_farm_blend` | `reserve_stats`, `list_reserves`, `position`, `deploy`, `supply`, `withdraw` | Blend Capital leveraged farming |
| `vanna_farm_lp` | `list_aquarius`, `aquarius_stats`, `lp_position`, `get_lp_balance`, `add_liquidity`, `remove_liquidity` | Aquarius / Soroswap LP |
| `vanna_swap` | `swap` | DEX swap |
| `vanna_wallet` | `list_bindings`, `list_smart_accounts`, `resolve`, `balance`, `token_balance`, `connect_start`, `connect_status` | Wallet identity & balances |
| `vanna_sign` | `enable_auto_sign`, `disable_auto_sign`, `session_status`, `sign_and_submit` | Delegated signing sessions |

`full` mode registers every one of the ~52 underlying operations above as its own individual tool (e.g. `vanna_borrow`, `vanna_repay`, `vanna_add_liquidity`) in addition to the 14 composites — same behavior, more granular schemas. See [MCP Server Guide § Two tool surfaces](./mcp-server-guide.md#two-tool-surfaces) for when to prefer one over the other.

### Notable per-tool behavior

- **`vanna_deposit_collateral`** accepts either an explicit `amount`, or a `percent` of the caller's wallet balance — mirroring the app's 10/25/50/100% deposit shortcuts.
- **`vanna_swap`** is direction-symmetric (`token_in`/`token_out`, either way) and, if you don't supply `min_out` or `expected_out` yourself, quotes `expected_out` from the live on-chain oracle price and derives a slippage-bounded `min_out` from your `slippage_pct` (default 0.5%).
- **`vanna_deploy_to_blend`** is Vanna's atomic leveraged-farming entrypoint — deposit collateral, borrow, and supply to Blend in one call. Its collateral-side asset symbol and its Blend-side asset symbol are **not always the same string** for the same real asset — see [Asset quirks](#asset-quirks) below.
- **`vanna_close_account`, `vanna_settle_account`, and `vanna_liquidate`** are not eligible for delegated auto-sign under any policy — they carry no single priced amount a spend-cap policy can evaluate, so they always require a direct wallet signature. See [Security & Safety Model](./security.md).

## Full tool catalogue (`full` mode — every individual tool)

`full` mode (the server's default) registers every operation below as its own MCP tool, in addition to the 14 composites above. Every write tool returns the standard `unsigned_xdr, auth_entries, fee_estimate, summary, function, contract, simulation_success` shape described in the [MCP Server Guide](./mcp-server-guide.md#the-write-tool-contract) unless noted otherwise — if the calling wallet has an active auto-sign session, these fields are replaced with `status="signed_and_submitted", tx_hash, explorer, ...` instead.

### Account lifecycle

| Tool | Description | Parameters | Type |
|---|---|---|---|
| `vanna_open_account` | Create a new isolated-margin smart account for a trader wallet. | `trader` (required) | Write |
| `vanna_close_account` | Close a smart account (must have zero open borrows) and return remaining collateral to the trader. | `smart_account`, `trader` (both required) | Write |
| `vanna_get_inactive_accounts` | List closed (inactive) smart account addresses for a trader. | `trader` (required) | Read |
| `vanna_resolve_account` | Resolve the smart-account address for a trader G-address, checking on-chain storage then the Sign Service directory. | `trader` (required), `smart_account` (optional) | Read |

### Margin — health, borrow, repay

| Tool | Description | Parameters | Type |
|---|---|---|---|
| `vanna_get_account_health` | Full health snapshot — collateral/debt USD, LTV, healthy flag, distance to liquidation. | `smart_account` (required) | Read |
| `vanna_get_debt` | List outstanding borrow positions on a smart account with live USD values. | `smart_account` (required) | Read |
| `vanna_get_margin_snapshot` | Composite snapshot combining health + collateral + debt + net borrow rate in one call. | `smart_account` (required) | Read |
| `vanna_can_borrow` | Pre-flight check for whether a borrow would be allowed, without building a transaction. | `smart_account`, `symbol`, `amount` (all required) | Read |
| `vanna_get_max_borrow` | The authoritative maximum amount currently borrowable for a symbol. | `smart_account`, `symbol` (both required) | Read |
| `vanna_borrow` | Borrow tokens from a lending pool against smart-account collateral. | `smart_account`, `symbol`, `amount`, `trader` (all required) | Write |
| `vanna_deposit_and_borrow` | Deposit collateral and borrow the *same* token symbol atomically. | `smart_account`, `deposit_amount`, `borrow_amount`, `symbol`, `trader` (all required) | Write |
| `vanna_deposit_and_borrow_cross` | Deposit one token as collateral and borrow a *different* token atomically. | `smart_account`, `deposit_amount`, `deposit_symbol`, `borrow_amount`, `borrow_symbol`, `trader` (all required) | Write |
| `vanna_repay` | Repay an outstanding borrow, full or partial — overpaying only repays actual debt. | `smart_account`, `symbol`, `amount`, `trader` (all required) | Write |
| `vanna_settle_account` | Settle (close) all outstanding borrow positions in one transaction. | `smart_account`, `trader` (both required) | Write |
| `vanna_liquidate` | Liquidate an undercollateralized smart account (LTV over the liquidation threshold). Permissionless — any address may call it. | `smart_account`, `liquidator` (both required) | Write |

### Collateral

| Tool | Description | Parameters | Type |
|---|---|---|---|
| `vanna_get_collateral_config` | The live on-chain collateral allowlist and risk caps. | none | Read |
| `vanna_get_collateral` | Collateral positions on a smart account with live USD values. | `smart_account` (required) | Read |
| `vanna_can_withdraw` | Pre-flight check for whether removing collateral would breach the health threshold. | `smart_account`, `symbol`, `amount` (all required) | Read |
| `vanna_deposit_collateral` | Deposit token collateral. Accepts an explicit `amount`, or a `percent` of the trader's wallet balance instead. | `smart_account`, `symbol` (required); `amount`, `trader`, `percent` (optional) | Write |
| `vanna_withdraw_collateral` | Withdraw token collateral back to the trader's wallet, subject to a health-check pre-flight. | `smart_account`, `symbol`, `amount`, `trader` (all required) | Write |

### Earn (Vanna lending pools)

| Tool | Description | Parameters | Type |
|---|---|---|---|
| `vanna_get_pool_stats` | Live stats for an Earn pool — utilization, borrow/supply APR and APY, totals. | `symbol` (required) | Read |
| `vanna_get_vtoken_exchange_rate` | Current vToken ↔ underlying exchange rate for a pool. | `symbol` (required) | Read |
| `vanna_get_vtoken_balance` | A lender's vToken balance and redeemable underlying amount. | `holder`, `symbol` (both required) | Read |
| `vanna_lend` | Deposit into an Earn pool, receiving vTokens. | `symbol`, `amount`, `lender` (all required) | Write |
| `vanna_redeem` | Redeem vTokens for underlying + accrued interest. Pass either `amount` (partial) or `redeem_all=true` — never both. | `symbol`, `lender` (required); `amount`, `redeem_all` (optional) | Write |

### Blend Capital (leveraged farming)

| Tool | Description | Parameters | Type |
|---|---|---|---|
| `vanna_get_blend_reserve_stats` | Pool-wide Blend reserve stats (supply/borrow APY, utilization) for XLM or USDC. | `symbol` (required) | Read |
| `vanna_list_blend_reserves` | List Blend XLM + USDC reserves together. | none | Read |
| `vanna_get_blend_position` | A smart account's Blend supply position (b-tokens + underlying value). | `smart_account` (required), `symbol` (optional — both if omitted) | Read |
| `vanna_get_farm_overview` | One-shot portfolio overview: Blend positions + reserve rates + Aquarius XLM/USDC LP. | `smart_account` (required) | Read |
| `vanna_deploy_to_blend` | Deposit collateral + borrow (optional) + supply to Blend, atomically. Collateral-side and Blend-side symbols can differ — see [Asset quirks](#asset-quirks). | `smart_account`, `deposit_amount`, `borrow_amount`, `token_symbol`, `blend_tokens_in`, `blend_amounts_in`, `trader` (required); `blend_pool_address` and several Blend-internal fields (optional) | Write |
| `vanna_blend_supply` | Plain (non-leveraged) supply of XLM or USDC into Blend. | `smart_account`, `symbol`, `amount`, `trader` (all required) | Write |
| `vanna_blend_withdraw` | Withdraw Blend supply. Pass `amount` for a partial withdrawal or `withdraw_all=true` for a full exit. | `smart_account`, `trader` (required); `amount`, `withdraw_all`, `blend_pool_address` (optional) | Write |

### Aquarius / Soroswap (liquidity, LP)

| Tool | Description | Parameters | Type |
|---|---|---|---|
| `vanna_list_aquarius_pools` | List Aquarius AMM pools, scoped to Vanna's farm pairs or the full listing. | `scope` (optional, default `vanna_farm`) | Read |
| `vanna_get_aquarius_pool_stats` | Aquarius pool stats for a specific token pair. | `token_a`, `token_b` (optional, default `XLM`/`USDC`) | Read |
| `vanna_get_farm_lp_position` | A smart account's LP position for a venue (Aquarius or Soroswap). | `smart_account` (required); `token_a`, `token_b`, `venue` (optional) | Read |
| `vanna_get_lp_balance` | A smart account's LP token balance for a venue/pair (Soroswap-resolvable; use `vanna_get_farm_lp_position` for Aquarius). | `smart_account` (required); `token_a`, `token_b`, `venue` (optional) | Read |
| `vanna_add_liquidity` | Add liquidity to a two-token pool (Soroswap or Aquarius), minting LP tokens to the smart account. | `smart_account`, `token_a`, `token_b`, `amount_a`, `amount_b`, `min_liquidity_out`, `trader` (required); `venue`, `fee_bps` (optional) | Write |
| `vanna_remove_liquidity` | Remove liquidity from a pool. Pass either a human `liquidity` amount (partial) or `remove_all=true` — never both. | `smart_account`, `token_a`, `token_b`, `trader` (required); `liquidity`, `min_amount_a`, `min_amount_b`, `venue`, `fee_bps`, `remove_all` (optional) | Write |

### Swap

| Tool | Description | Parameters | Type |
|---|---|---|---|
| `vanna_swap` | Swap one token for another via Soroswap or Aquarius. `min_out` can be given directly, derived from `expected_out` + `slippage_pct`, or auto-quoted from the on-chain oracle if both are omitted. | `smart_account`, `token_in`, `token_out`, `amount_in`, `trader` (required); `min_out`, `venue`, `fee_bps`, `slippage_pct`, `expected_out`, `deadline_minutes` (optional) | Write |

### Oracle & protocol info

| Tool | Description | Parameters | Type |
|---|---|---|---|
| `vanna_get_price` | Current USD price for one token from the on-chain oracle. | `symbol` (required) | Read |
| `vanna_get_prices_batch` | Current USD prices for multiple tokens in one call. | `symbols` (required, list) | Read |
| `vanna_list_protocol_addresses` | All resolved Vanna contract addresses for the current network. | none | Read |

### Wallet & generic token reads

| Tool | Description | Parameters | Type |
|---|---|---|---|
| `vanna_get_wallet_balance` | Spendable wallet balances — native XLM plus each USDC-family token, labeled by symbol and contract. | `g_address` (required) | Read |
| `vanna_get_token_balance` | Generic SEP-41 balance read for any holder and any token contract. | `holder`, `token_contract` (both required) | Read |
| `vanna_connect_wallet_start` | Begin the wallet-connect flow, minting a one-time link for the user to authorize Vanna as a signer. Does **not** enable auto-sign by itself. | none | Write (session mint) |
| `vanna_connect_wallet_status` | Poll a connect request's status — safe to call repeatedly. | `request_id` (required) | Read |

### Delegated signing (Sign Service)

| Tool | Description | Parameters | Type |
|---|---|---|---|
| `vanna_enable_auto_sign` | Enable delegated auto-sign for a wallet. Two-step flow: a bare first call returns the available cap options; a second call with your choice (default caps, or `max_per_tx_usd`/`max_per_day_usd`) creates the session. | `wallet_address`, `user_id` (required); `use_default_caps`, `max_per_tx_usd`, `max_per_day_usd`, `expires_in_hours`, and others (optional) | Write / session mgmt |
| `vanna_disable_auto_sign` | Revoke a wallet's active auto-sign session immediately. | `wallet_address` (required) | Write / session mgmt |
| `vanna_auto_sign_status` | Read a wallet's current auto-sign session status. *(Reachable via the composite `vanna_sign(action="session_status")`; not separately registered in `full` mode.)* | `wallet_address` (required) | Read |
| `vanna_sign_and_submit` | Sign and submit a pre-built unsigned XDR through an active auto-sign session, policy-checked against its caps and allowlists. | `unsigned_xdr`, `user_id` (required); `wallet_address` (optional) | Write / Sign |
| `vanna_list_my_wallet_bindings` | List wallets bound to the caller's verified identity. | none | Read |
| `vanna_list_smart_accounts` | List smart accounts for a trader wallet, merging on-chain state with the Sign Service directory. | `wallet_address` (required) | Read |
| `vanna_register_smart_account` | Record a known smart-account address for a trader wallet in the Sign Service directory. | `wallet_address`, `smart_account` (required); `tx_hash` (optional, required under identity enforcement) | Write (directory record) |
| `vanna_unregister_smart_account` | Remove a smart-account mapping for a trader wallet. | `wallet_address`, `smart_account` (both required) | Write (directory record) |

## Supported assets

| Symbol | Decimals | Role |
|---|---|---|
| XLM | 7 | Native asset — margin, collateral, Earn, farm, swap, LP |
| USDC | 6 | Oracle/lending alias — see below |
| BLUSDC | 6 | Vanna's own USDC lending/margin pool |
| AQUSDC | 6 | Aquarius USDC pool |
| SOUSDC | 6 | Soroswap USDC pool |
| EURC | 6 | Euro-pegged stablecoin — lending pool and vToken exist; typically **not** collateral-eligible on testnet |

vToken forms (Earn receipt tokens): `VXLM`, `VBLUSDC`, `VAQUSDC`, `VSOUSDC`, `VEURC`.

LP pairs (Aquarius/Soroswap; no standalone oracle price — priced only as a pair): `AQ_XLM_USDC`, `SS_XLM_USDC`, `AQ_XLM_AQUA`, `AQ_XLM_USDT`. AQUA and USDT only exist as legs of these pairs — neither is independently lendable, borrowable, or usable as collateral.

### Asset quirks

These are real, current behaviors worth knowing before you hardcode a symbol:

- **`USDC` is an oracle/lending alias, not a fourth pool.** `BLUSDC`, `AQUSDC`, `SOUSDC` (and their venue-qualified spellings) all canonicalize to `USDC` for **price lookups only** — they share one USD price feed even though they are three economically distinct, non-fungible pools. Depositing into or borrowing from the wrong one is a real mistake, not just a display quirk.
- **The collateral allowlist is not the same as the lending-symbol list**, and it's on-chain, not static — always read it live via `vanna_protocol_info(action="collateral_config")` rather than hardcoding it. On testnet, `XLM`, `BLUSDC`, `AQUSDC`, `SOUSDC` are collateral-eligible; plain `USDC` and `EURC` typically are not.
- **Blend symbol asymmetry**: for `vanna_deploy_to_blend`, the collateral leg uses the collateral-allowlist symbol (`BLUSDC` for a USDC deposit) while the Blend-side leg (`blend_tokens_in`) uses the Blend reserve's own symbol, which for USDC is plain `USDC`. XLM is `"XLM"` on both legs — no asymmetry there. Getting this backwards used to be a hard failure; it's now preflighted with a clear rejection instead of a stuck transaction.
- `vanna_blend_supply` / `vanna_blend_withdraw` (plain Blend supply, no borrow) only support `XLM` and `USDC`, and treat `BLUSDC` as an alias for `USDC` — the reverse normalization direction from collateral.

## Protocol addresses

All contract addresses except the Registry itself are resolved at runtime from an on-chain **Registry contract**, cached for 5 minutes, rather than hardcoded — call `vanna_protocol_info(action="list_addresses")` for the live set. The only address a client needs configured up front is the Registry ID for the network you're targeting; everything else (margin pools, RiskEngine, RateModel, Oracle, AccountManager, Blend pool, Aquarius router, Soroswap router) is resolved from it.

Domains covered: margin lending (per-asset pools), Earn (vToken pools), Blend Capital (leveraged farming), Aquarius and Soroswap (liquidity/swap).
