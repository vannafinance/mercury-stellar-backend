# Knowledge Transfer — Vanna Copilot + MCP (2026-08)

**Audience:** engineers onboarding to the agent stack  
**Branch:** `copilot-assistant`  
**Scope:** Next.js copilot brain + Vanna MCP tools + Sign Service + domain firewall  

---

## 1. One-sentence model

**MCP = tools** (reads/writes on Stellar). **Copilot = orchestrator** (understand → plan → call tools → report). **Sign Service = policy + submit**. Never invent numbers or hashes.

---

## 2. Where code lives

| Piece | Path |
|-------|------|
| Chat API | `app/api/copilot/route.ts` |
| Brain entry | `lib/copilot/handle.ts` |
| Domain firewall | `lib/copilot/domain-firewall.ts` |
| Multi-leg runner | `lib/copilot/multi-leg-agent.ts` |
| Step extract + LLM plan | `lib/copilot/step-extractor.ts`, `llm-planner.ts` |
| MCP client | `lib/copilot/mcp-client.ts` (`toServerCall` legacy→14 tools) |
| Page Ask assistant | `lib/copilot/page-agent.ts`, `components/copilot/assistant-*` |
| Privy wallet create | `contexts/privy-wallet-bridge.tsx` (**app**, not MCP) |

---

## 3. Request path

```
POST /api/copilot
  → domain firewall (block coding / off-topic BEFORE Vertex)
  → page agent OR router/Vertex OR multi-leg plan
  → MultiLegAgent expand → preflight → runWrite (MCP) → HF observe
  → ChatResponse (strategy card / prose)
```

---

## 4. LLM firewall (billing protection)

**What it is:** Pre-model gate + system prompts so users cannot burn Vertex on free coding/homework (classic “support bot used as free ChatGPT” abuse).

**Layers:**
1. `evaluateDomainFirewall()` — blocklist (code, essay, leetcode) + allowlist (Vanna/DeFi)  
2. System prompts restate domain  
3. MCP only exposes DeFi tools (cannot “run Python”)  

**Not a network WAF** — product/domain LLM firewall.

---

## 5. Multi-leg (plan-then-execute)

1. Understand (LLM plan + clause extract + keywords)  
2. Validate ops allowlist + sanitize HF≠amount  
3. Expand farm@Nx → deposit, borrow, supply  
4. Execute sequential MCP writes; stop on fail; resume remaining  
5. Honest step report  

**No LangChain package** — same *ideas* as LangChain/Anthropic workflows.

---

## 6. Wallet create

| Action | How |
|--------|-----|
| Create **G-wallet** (Privy) | App Connect modal / login — **not** MCP |
| Open **margin C-account** | Copilot `create_account` → MCP `vanna_account` open |
| List SA / resolve | MCP `vanna_wallet` list_smart_accounts / resolve |

---

## 7. Deploy

- **Copilot app:** Cloud Run this Next repo (owner). Timeout ≥ 300s.  
- **MCP:** no redeploy required for multi-leg/firewall work in this branch.  
- **No new GCP project.**

---

## 8. Docs map

| Doc | Use |
|-----|-----|
| `docs/VANNA_COPILOT_FULL.md` | Full product/tech documentation |
| `docs/KT_COPILOT_MCP.md` | This KT |
| `docs/prompts/COPILOT_PROMPT_LIBRARY.md` | Test prompts (copilot) |
| `docs/prompts/MCP_PROMPT_LIBRARY.md` | MCP-oriented prompts |
| `docs/MCP_TOOLS_PUBLIC.md` | Website-style tool reference (HeyGen-like) |
| `docs/SYSTEM_CHANGELOG.md` | Change log |
| `docs/MULTI_LEG_RESEARCH.md` | Architecture research |

---

## 9. Tests

```bash
npm run test:multi-leg
npx vitest run tests/lib/domain-firewall.test.ts
```
