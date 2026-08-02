# MCP-oriented prompt / tool exercise library

Use with MCP Inspector, Grok MCP, or copilot (which maps to these tools).  
Sanujit-style coverage + multi-leg sequences as **ordered tool calls**.

---

## Reads (single tool)

| Goal | Tool / action | Example args |
|------|---------------|--------------|
| Price | `vanna_oracle` get_price | `{ symbol: "XLM" }` |
| Prices batch | `vanna_oracle` get_prices_batch | `{ symbols: ["XLM","USDC"] }` |
| Pool stats | `vanna_earn_market` pool_stats | `{ symbol: "USDC" }` |
| Health | `vanna_margin_status` health | `{ smart_account }` |
| Collateral | `vanna_margin_status` collateral | `{ smart_account }` |
| Debt | `vanna_margin_status` debt | `{ smart_account }` |
| Can borrow | `vanna_margin_trade` can_borrow | `{ smart_account, symbol, amount }` |
| Wallet balance | `vanna_wallet` balance | `{ g_address }` |
| Smart accounts | `vanna_wallet` list_smart_accounts | `{ wallet_address }` |
| Resolve | `vanna_wallet` resolve | `{ g_address }` |
| Blend reserves | `vanna_farm_blend` list_reserves | `{}` |
| Blend position | `vanna_farm_blend` position | `{ smart_account }` |
| Farm overview | `vanna_farm_overview` overview | `{}` |

---

## Writes (build XDR → sign)

| Goal | Tool / action |
|------|----------------|
| Open account | `vanna_account` open |
| Lend | `vanna_earn_write` lend |
| Redeem | `vanna_earn_write` redeem |
| Deposit collateral | `vanna_margin_trade` deposit |
| Borrow | `vanna_margin_trade` borrow |
| Repay | `vanna_margin_trade` repay |
| Blend supply | `vanna_farm_blend` supply |
| Blend deploy (atomic; often budget-fail) | `vanna_farm_blend` deploy |
| Swap | `vanna_swap` swap |
| Enable auto-sign | `vanna_sign` enable_auto_sign |
| Sign submit | `vanna_sign` sign_and_submit |

---

## Multi-leg sequences (MCP manual)

### Park then farm @2× (sequential — preferred)

1. `earn_write` lend 20 XLM  
2. `margin_trade` deposit 10 BLUSDC  
3. `margin_trade` borrow 10 BLUSDC  
4. `farm_blend` supply 10 BLUSDC  

### Swap then farm @2×

1. `vanna_swap` 10 XLM → AQUSDC/BLUSDC path  
2. deposit → borrow → supply as above  

### Deposit + borrow only

1. deposit  
2. borrow  

---

## Sanujit-style MCP checks

| Case | Expect |
|------|--------|
| Negative amount | Block / error before sign |
| Unsupported asset DOGE | Error |
| Over wallet balance lend | Preflight / sim fail |
| Extreme leverage | Cap / refuse |
| Atomic deploy on populated pool | May Budget ExceededLimit → use sequential |

---

## Wallet create via MCP?

**No Privy G-wallet create tool** on vanna-mcp.  
MCP can **open margin account** and **list/resolve** smart accounts.  
G-wallet creation is **Privy in the app**.

---

## Domain firewall note

Off-domain prompts (coding) never reach MCP when going through copilot.  
Direct MCP clients (Inspector) still only see DeFi tools.  
