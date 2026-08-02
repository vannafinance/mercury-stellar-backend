# Vanna Finance MCP tools

**Audience:** developers integrating Vanna MCP (website docs style, inspired by [HeyGen MCP tool tables](https://developers.heygen.com/mcp/overview)).  
**Server:** Vanna Finance MCP on Stellar/Soroban (testnet by default).  
**Endpoint:** `https://mcp.vanna.finance/mcp` (env-specific).

HeyGen exposes video tools for multi-step video agents. Vanna exposes **DeFi tools** for multi-step finance agents. Multi-leg **orchestration** lives in the **copilot** (or your agent), not as one mega MCP tool.

---

## Auth

- WorkOS M2M (client credentials) → Bearer token on Streamable HTTP MCP.  
- Writes that auto-sign use Sign Service policy (session / caps).

---

## Tool catalog (consolidated)

Each tool takes `{ action, kwargs }`. Legacy fine-grained names are translated by official clients.

### Oracle — `vanna_oracle`

| Action | Description |
|--------|-------------|
| `get_price` | Price for one symbol |
| `get_prices_batch` | Prices for many symbols |

### Protocol info — `vanna_protocol_info`

| Action | Description |
|--------|-------------|
| `list_addresses` | Protocol contract addresses |
| `collateral_config` | Collateral parameters |

### Account lifecycle — `vanna_account`

| Action | Description |
|--------|-------------|
| `open` | Open margin / smart account |
| `close` | Close account |
| `list_inactive` | Inactive accounts |

### Margin status — `vanna_margin_status`

| Action | Description |
|--------|-------------|
| `health` | Health factor / risk snapshot |
| `collateral` | Collateral positions |
| `debt` | Debt positions |
| `max_borrow` | Max borrow estimate |

### Margin trade — `vanna_margin_trade`

| Action | Description |
|--------|-------------|
| `deposit` | Deposit collateral |
| `withdraw` | Withdraw collateral |
| `borrow` | Borrow |
| `repay` | Repay |
| `deposit_and_borrow` | Combined (preflight caveats) |
| `can_borrow` / `can_withdraw` | Preflight checks |
| `settle` | Settle |

### Earn market — `vanna_earn_market`

| Action | Description |
|--------|-------------|
| `pool_stats` | Pool APY / utilization |
| `exchange_rate` | vToken exchange rate |

### Earn position — `vanna_earn_position`

| Action | Description |
|--------|-------------|
| `balance` | User earn / vToken balance |

### Earn write — `vanna_earn_write`

| Action | Description |
|--------|-------------|
| `lend` | Supply to earn |
| `redeem` | Withdraw from earn |

### Farm overview — `vanna_farm_overview`

| Action | Description |
|--------|-------------|
| `overview` | Farm products snapshot |

### Farm Blend — `vanna_farm_blend`

| Action | Description |
|--------|-------------|
| `list_reserves` | Blend reserves |
| `reserve_stats` | One reserve stats |
| `position` | User Blend position |
| `supply` | Supply free balance to Blend |
| `withdraw` | Withdraw from Blend |
| `deploy` | Levered deploy (may hit Soroban budget — prefer sequential) |

### Farm LP — `vanna_farm_lp`

| Action | Description |
|--------|-------------|
| `list_aquarius` / `aquarius_stats` | Aquarius pools |
| `add_liquidity` / `remove_liquidity` | LP actions |
| `lp_position` / `get_lp_balance` | LP balances |

### Swap — `vanna_swap`

| Action | Description |
|--------|-------------|
| `swap` | DEX swap via margin free balance (Aquarius / Soroswap) |

### Wallet — `vanna_wallet`

| Action | Description |
|--------|-------------|
| `balance` | G-wallet balances |
| `token_balance` | Single token |
| `list_bindings` | Wallet bindings |
| `list_smart_accounts` | C-accounts for G-wallet |
| `resolve` | Resolve smart account |

### Sign — `vanna_sign`

| Action | Description |
|--------|-------------|
| `enable_auto_sign` | Enable session auto-sign |
| `disable_auto_sign` | Disable |
| `sign_and_submit` | Sign + submit XDR |

---

## Multi-step strategies

Vanna MCP tools are **atomic**. Multi-leg strategies (park then farm @2×) are orchestrated by:

- **Vanna Copilot** MultiLegAgent, or  
- Your own agent calling tools in order  

Example sequence:

1. `earn_write.lend`  
2. `margin_trade.deposit`  
3. `margin_trade.borrow`  
4. `farm_blend.supply`  

---

## Domain boundary

Tools only cover Vanna Finance / Stellar DeFi. There is no general coding or arbitrary chain execution surface.

---

## Related

- Copilot full doc: `docs/VANNA_COPILOT_FULL.md`  
- Prompt libraries: `docs/prompts/`  
