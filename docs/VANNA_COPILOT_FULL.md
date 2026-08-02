# Vanna Copilot — Full documentation

**Product:** Agent-native DeFi assistant for Vanna Finance (Stellar / Soroban)  
**Stack:** Next.js brain · Vertex (Gemini) · Vanna MCP · Sign Service · Freighter/Privy  

---

## 1. Purpose

Users type English (including multi-step strategies). The copilot:

1. Stays **inside Vanna Finance domain** (LLM firewall)  
2. Plans single- or multi-leg actions  
3. Executes via **MCP tools** and **Sign Service**  
4. Reports honestly (hashes, partial failure, HF)

---

## 2. Architecture

```
┌──────────────┐     ┌────────────────────┐     ┌─────────────┐
│ Browser UI   │────►│ Next /api/copilot  │────►│ Vertex LLM  │
│ /copilot +   │     │ domain firewall    │     │ plan/explain│
│ Ask page     │     │ MultiLegAgent      │     └─────────────┘
└──────────────┘     │ mcp-client         │────────────┐
                     └────────────────────┘            ▼
                                              ┌────────────────┐
                                              │ Vanna MCP      │
                                              │ (14 tools)     │
                                              └────────┬───────┘
                                                       ▼
                                              ┌────────────────┐
                                              │ Sign Service   │
                                              │ auto-sign/submit│
                                              └────────────────┘
```

**Same split as Coinbase AgentKit-style systems:** tools vs orchestration.  
**Difference:** we use a **validated plan + sequential executor**, not free multi-agent tool roulette (safer for money).

### Why not LangChain?

LangChain/LangGraph are fine for prototypes. Production Vanna already has:

- Vertex routing + planner  
- Deterministic expand/execute  
- MCP + Sign Service  

Adding LangChain would not improve custody or risk; it would add dependency cost. We **reuse plan-then-execute ideas** without the package.

---

## 3. LLM domain firewall

### Problem
Public chatbots get used for free coding → **runaway LLM bills**.

### Solution (implemented)

| Layer | Implementation |
|-------|----------------|
| Pre-Vertex block | `evaluateDomainFirewall()` in `handleChat` |
| Allow Vanna domain | earn/farm/margin/swap/HF/wallet/screen |
| Block abuse | coding, leetcode, essays, off-topic |
| Prompt defense | `DOMAIN_FIREWALL_SYSTEM` on page agent + planner |
| Tool surface | MCP only exposes DeFi tools |

**Tests:** `tests/lib/domain-firewall.test.ts`

---

## 4. Multi-leg strategies

### Plan-then-execute pipeline

1. Domain firewall  
2. LLM planner (`llm-planner.ts`) — free-form English → JSON steps  
3. Clause extractor (`step-extractor.ts`) — `then` / `and then` order  
4. Keyword multi-goal (`router.tryMultiGoalPlan`)  
5. Sanitize (HF floor ≠ amount)  
6. Expand levered farm → deposit, borrow, supply  
7. Preflight → MCP write → HF observe → stop/resume  
8. Strategy UI card  

### Example

Input: `park 20 XLM for yield then farm 10 BLUSDC at 2x keep HF above 1.4`

Expanded legs:

1. Lend 20 XLM on Earn  
2. Deposit 10 BLUSDC collateral  
3. Borrow 10 BLUSDC  
4. Supply 10 BLUSDC to Blend  

---

## 5. Surfaces

| UI | Role |
|----|------|
| `/copilot` | Full workspace, multi-leg execution, session log |
| Ask page panel | Page-aware Q&A; history in `localStorage`; **New chat** clears history |
| Wallet connect | Freighter + **Create Vanna wallet** (Privy) |

---

## 6. Wallet create

| Goal | Mechanism | MCP? |
|------|-----------|------|
| New Stellar G-wallet | Privy `createWallet({ chainType: "stellar" })` on login | **No** |
| Margin C-account | `create_account` → `vanna_account` open | **Yes** |
| List / resolve SA | `vanna_wallet` list_smart_accounts / resolve | **Yes** |

There is **no** `create_wallet` MCP tool on vanna-mcp for Privy — by design (keys stay client-side).

---

## 7. MCP tools (summary)

See **`docs/MCP_TOOLS_PUBLIC.md`** for website-style reference (HeyGen-like).

Consolidated dispatchers (14): `vanna_oracle`, `vanna_protocol_info`, `vanna_account`, `vanna_margin_status`, `vanna_margin_trade`, `vanna_earn_market`, `vanna_earn_position`, `vanna_earn_write`, `vanna_farm_overview`, `vanna_farm_blend`, `vanna_farm_lp`, `vanna_swap`, `vanna_wallet`, `vanna_sign`.

Client maps legacy names via `toServerCall`.

---

## 8. HeyGen MCP ideas (video → finance mapping)

HeyGen MCP exposes **domain tools** (create video agent, list styles, sessions) for multi-turn video generation — multi-step inside their domain, not free coding.

| HeyGen idea | Vanna analogue |
|-------------|----------------|
| Domain-only tools | MCP DeFi tools only |
| Multi-step “agent” session | MultiLegAgent + resume |
| Auth before generate | Wallet + smart account + Sign Service |
| Docs as tool tables | `MCP_TOOLS_PUBLIC.md` |

We do **not** need their video stack — we mirror **domain MCP + multi-step product agent**.

---

## 9. Environment

```env
LLM_PROVIDER=vertex
GOOGLE_CLOUD_PROJECT=vanna-mcp
VERTEX_MODEL=gemini-2.5-flash   # or gemini-3.6-flash if available
VERTEX_MODEL_FALLBACKS=gemini-2.5-flash,gemini-2.0-flash-001
MCP_MODE=live
MCP_BASE_URL=https://mcp.vanna.finance/mcp
WORKOS_M2M_CLIENT_ID=...
WORKOS_M2M_CLIENT_SECRET=...
COPILOT_READS_ONLY=false
NEXT_PUBLIC_PRIVY_APP_ID=...
```

---

## 10. Deploy

Only **this Next app** needs redeploy for copilot multi-leg + firewall.  
**MCP redeploy not required** for this branch’s features.

```bash
gcloud run deploy <EXISTING_SERVICE> --project=<EXISTING_PROJECT> --region=<REGION> --source=. --timeout=300
```

---

## 11. Related docs

- KT: `docs/KT_COPILOT_MCP.md`  
- Prompts: `docs/prompts/*`  
- MCP public tools: `docs/MCP_TOOLS_PUBLIC.md`  
- Changelog: `docs/SYSTEM_CHANGELOG.md`  
