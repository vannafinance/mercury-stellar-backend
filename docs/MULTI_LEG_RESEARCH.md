# Multi-leg research → Vanna design choices

How production agent systems handle multi-step goals, and what we adopt for Vanna Finance.

---

## What industry does (not LangChain-as-a-dependency)

| Pattern | Who | Idea | Use for Vanna? |
|---------|-----|------|----------------|
| **Plan-then-execute** | LangChain planning agents | First produce an ordered plan, then run each step with tools | **Yes** — `tryMultiGoalPlan` + `extractOrderedPlan` → `expandPlanWrites` → `runPlan` |
| **Observe after act** | Anthropic agent loop | After each tool call, read ground truth before next step | **Yes** — HF sample, step status, `progress {done,total}` |
| **Fixed workflows for known chains** | Anthropic *Building effective agents* | Prefer prompt-chaining / workflows over free agents when the task decomposes cleanly | **Yes** — deposit→borrow→supply is a **workflow**, not free tool roulette |
| **Don’t over-use multi-agent** | Anthropic multi-agent research, LangChain | Subagents for parallel research; sequential money moves stay single chain | **Yes** — one ordered MultiLegAgent (safer for DeFi) |
| **Clear session boundaries** | Gemini / ChatGPT | New chat so old context doesn’t poison the next goal | **Yes** — Ask-page New chat (not /copilot page) |
| **Verify before / after money moves** | Coinbase AgentKit, DeFi agents (general) | Policy + balance checks around execution | **Yes** — preflight lend balance; Sign Service policy |

### What we deliberately do **not** use

| Skip | Why |
|------|-----|
| **LangChain / LangGraph package in prod** | We already have Vertex + MCP + Sign Service; adding a framework adds cost without custody/risk control |
| **Free ReAct tool loop for farm** | Can re-order legs wrong (borrow before deposit); bad for money |
| **Parallel subagents for one strategy** | Parallel deposit+borrow races; sequential is correct |
| **mcp-use widgets / multi-agent OS** | Out of scope; pattern only |

---

## How Vanna turns a long prompt into legs

```
User long prompt
    │
    ├─① Clause split (then / and then / after that / ;)
    │     step-extractor.ts  → ordered ops
    ├─② Keyword multi-goal plan (router tryMultiGoalPlan)
    ├─③ Vertex plan (when semantic) + preferMultiGoalPlan merge
    ├─④ preferExtractedPlan (clause order wins when richer)
    ├─⑤ expandPlanWrites (farm@2× → deposit, borrow, supply)
    ├─⑥ preflight → run each leg → observe HF → stop rules
    └─⑦ Strategy card + resume remaining
```

### Examples

| User says | Extracted plan |
|-----------|----------------|
| park 20 XLM then farm 10 BLUSDC at 2x keep HF above 1.4 | lend 20 XLM → deploy@2× → expand to 4 legs |
| swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC | swap XLM→BLUSDC → deploy@2× → 4 legs |
| repay 5 BLUSDC then deposit 10 XLM | repay → deposit_collateral |

---

## DeFi / finance copilots (public patterns)

Public write-ups (Coinbase AgentKit, Anthropic finance tooling, generic DeFi “agent” demos) converge on:

1. **Atomic tools** (swap, lend, borrow) — not one mega “do strategy” tool  
2. **Orchestration in the app/agent layer** — same as our MultiLegAgent  
3. **Human or policy gate** before spend — our Sign Service / auto-sign caps  
4. **Honest partial failure** — never claim later legs succeeded  

Vanna is aligned: **MCP = tools**, **copilot = orchestrator**.

---

## Architecture we target (false-proof enough for DeFi)

```
                 ┌─────────────────────┐
  User prompt ──►│ Understanding layer │  Vertex free-form (llm-planner)
                 │ + clause extractor  │  + keyword fallback
                 └──────────┬──────────┘
                            ▼
                 ┌─────────────────────┐
                 │ Validated plan JSON │  allowlisted ops only
                 │ sanitize amounts/HF │
                 └──────────┬──────────┘
                            ▼
                 ┌─────────────────────┐
                 │ MultiLegAgent       │  expand @Nx → atomic legs
                 │ plan-then-execute   │  preflight → MCP write → observe
                 └──────────┬──────────┘
                            ▼
                 ┌─────────────────────┐
                 │ MCP tools + Sign    │  policy / custody boundary
                 └─────────────────────┘
```

**Not hardcoding user phrases** — the LLM planner accepts any English;  
**not free agents** — ops must pass allowlist + MultiLegAgent order rules.

### Model flexibility
- Primary: `VERTEX_MODEL` (default gemini-3.6-flash)
- Fallbacks: `VERTEX_MODEL_FALLBACKS` (gemini-2.5-flash, …) when primary 404s
- Changing models improves language understanding; **execution safety stays in code**

## What to improve next (priority)

1. ~~Clause-order extraction~~ + ~~LLM planner~~  
2. Streaming plan progress (UI)  
3. Free C-balance observe before Blend supply  
4. Optional: short “plan preview” confirm for high-notional multi-leg  

---

## MCP deploy

**No MCP server changes required** for multi-leg orchestration or this extractor.  
Only the **Next copilot app** needs deploy for production.
