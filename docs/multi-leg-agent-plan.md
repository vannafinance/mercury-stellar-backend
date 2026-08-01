# Multi-leg agent plan (mcp-use inspired, Vanna-owned)

**Branch:** `copilot-assistant`  
**Date:** 2026-08-02  
**Status:** Phase 1–3 complete + production hardening — see `docs/PRODUCTION_MULTI_LEG.md`  
**Wallet / Privy:** Connect modal create/save copy + toast; create-on-login in PrivyWalletBridge 

---

## 1. Goal

Heavy user prompts with **multiple linked actions** (e.g. park XLM for yield **then** farm BLUSDC at 2× **while** keeping HF ≥ 1.4) must:

1. Be **understood** as a multi-step plan (not collapsed to one read/write)
2. **Execute** legs in order via MCP + auto-sign when possible
3. **Report** honestly: step table, hashes, partial success, HF, blockers
4. **Never invent** numbers or claim farm done when Blend supply failed

This is the product core of the copilot — not a chatbot FAQ.

---

## 2. Inspiration from mcp-use (what we take / skip)

| From mcp-use | Use? | How |
|--------------|------|-----|
| `MCPAgent` multi-step loop (plan → tool → observe → next) | **Yes (pattern)** | Homegrown loop in our brain |
| `MCPClient` multi-server sessions | **Later / optional** | Improve session reuse if still slow |
| Inspector for tool testing | **Yes (process)** | Scripted multi-leg matrix in `tmp/` or CI |
| MCP Apps / widgets | **No** | Out of scope |
| Rewrite Python MCP in their SDK | **No** | Keep `vanna_mcp` as source of truth |
| Manufact hosting | **No** | Keep current Cloud Run |

**We do not depend on the mcp-use package for production.** We copy the **agent loop idea**, keep Vanna tools + risk + Sign Service.

---

## 3. Current state (what already works)

| Capability | Status |
|------------|--------|
| Sign Service Blend Deposit decode | Deployed (`00036-bnd`); farm supply auto-sign verified |
| Sequential deposit → borrow → Blend supply | Verified on CBOQAN… |
| Keyword multi-goal plan (`park` + `farm`) | Partial — amounts sometimes missing |
| `runPlan` in `handle.ts` | Exists but weak: limited steps, little HF mid-check, report uneven |
| Client `next_step` chain | Exists for split deposit_and_borrow / deploy_to_blend |
| Full free-form multi-leg intelligence | **Gap** — heavy prompts need robust planner + runner |

---

## 4. Architecture (target)

```
User heavy prompt
       │
       ▼
┌──────────────────┐
│  Plan builder    │  Vertex + keyword hybrid
│  (ordered legs)  │  → LegStep[]
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ MultiLegAgent    │  NEW: lib/copilot/multi-leg-agent.ts
│  for each leg:   │
│   - preflight    │  (amount, asset, HF floor, USDC map)
│   - runWrite /   │  existing runWrite / MCP reads
│     runRead      │
│   - record step  │  hash, status, HF sample
│   - stop rules   │  block / needs_sign / HF breach
└────────┬─────────┘
         │
         ▼
 ChatResponse {
   kind, message (structured table),
   execution.steps[],
   next_step? (if paused for client chain),
   data: { plan, legs, hf_floor, smart_account }
 }
```

**Fixed smart account for tests:**  
`CBOQAN5NFII4P5HD73M2IRSFYZSXC5XC76FQWQ5JU7LJAO66TFFPG5XY`  
Wallet: `GD4BQRQPYLVM7YS57V4USR265UFZFEXIVDJJBIK3BAFQJ3F6SCA5NPDH`

---

## 5. Implementation phases

### Phase 1 — MultiLegAgent core (this sprint)  **← START NOW**

**Files:**
- `lib/copilot/multi-leg-agent.ts` — runner + step report builder
- `lib/copilot/handle.ts` — route plans through MultiLegAgent
- `lib/copilot/types.ts` — richer `execution.steps` if needed
- Light planner improvements in `router.ts` / Vertex plan shape

**Runner rules:**
1. Max 8 legs; expand nested multi-leg ops (`deploy_to_blend@2x` → deposit, borrow, supply)
2. Between legs: optional HF read (with budget fallback)
3. If `min_hf` set and HF after leg &lt; floor → **stop** (no further borrows/supplies)
4. On `needs_wallet_sign` / `needs_auto_sign` → return partial table + pending action
5. On leg error → stop; never mark later legs success
6. Final message: markdown-free structured steps (intro + numbered steps + HF note)

**Success:**  
Prompt `park 20 XLM for yield then farm 10 BLUSDC at 2x keep HF above 1.4` produces a **full step report** end-to-end with hashes when auto-sign is on.

### Phase 2 — Smarter planning ✅

- Vertex already used for ≥2 action domains or length &gt; 90 (`needsSemanticIntent`)
- `plan-sanitize.ts`: never treat HF floors as amounts; fill from `N ASSET` only
- `preferMultiGoalPlan`: keyword multi-goal plan wins when Vertex collapses to one write
- Vertex `make_plan` + JSON router: leverage on steps; stronger amount rules
- Router: broader multi-goal (repay/swap chains, then/and + risk language)
- UI: strategy progress panel from `data.multi_leg_steps`

### Phase 3 — Resilience & DX ✅

- MCP Streamable-HTTP **session reuse** already on process singleton (`mcp-client.ts`)
- Smoke: `npx tsx tmp/multi-leg-smoke.mts` + `tmp/smoke-expand.mts`
- Optional mcp-use client **not** added to prod (not needed)

### Wallet create + Privy modal (product polish) ✅ light

- Connect modal: **Create Vanna wallet** (email/Google) + explain create & save
- `PrivyWalletBridge` already creates embedded Stellar wallet on login and syncs store
- Deeper save/export UX (seed-less recovery messaging, post-create toast) can still improve

---

## 6. How much this helps (value)

| Pain today | After MultiLegAgent | Impact |
|------------|---------------------|--------|
| Heavy prompt → one leg or wrong read | Ordered plan + execute | **High** — core UX |
| “Farm done” when only margin moved | Honest partial table | **High** — trust |
| Stuck after deposit (no borrow) | Expand + chain legs | **High** |
| HF floor ignored mid-strategy | Mid-leg HF stop | **Medium–High** |
| Hard to debug multi-leg | Same step table in API + UI | **Medium** |
| mcp-use widgets / rewrite | Not doing | Avoided cost |

**What it does *not* replace:**  
Sign Service policy, on-chain budget limits, wallet signatures when auto-sign off, Privy create-wallet UX.

**Rough effort:**
- Phase 1: **1–2 days**
- Phase 2: **1–2 days**
- Phase 3: **0.5–1 day** optional

---

## 7. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Vertex invents bad steps | Guard rails + keyword expand of known multi-leg ops |
| Long latency (N MCP sessions) | Parallel only for pure reads; session reuse later |
| HF RPC budget exceed | Existing collateral+debt fallback |
| Double-submit on retry | Idempotent messaging; don’t auto-retry failed supply without user |

---

## 8. Definition of done

### Phase 1
- [x] `multi-leg-agent.ts` owns plan expansion + report helpers
- [x] `handle.ts` `runPlan` uses expand → sequential `runWrite` → HF sample → report
- [x] Structured step report + `execution.steps` + `data.multi_leg_steps`
- [x] Expand levered farm into 3 internal legs
- [x] HF floor stop rule
- [x] Clean product labels (no `2× leg 2/3`)
- [ ] Live retest: park 20 XLM + farm 10 BLUSDC @ 2× on CBOQAN… (operator)

### Phase 2–3
- [x] plan-sanitize + prefer keyword multi-goal
- [x] Vertex plan leverage + amount rules
- [x] Multi-leg progress UI
- [x] Offline smoke matrix
- [x] Privy connect modal create/save copy

---

## 9. Proceed order

1. **Now:** Phase 1 MultiLegAgent  
2. **Then:** Phase 2 planner quality  
3. **Later:** Wallet create + save Privy modal  
4. **Optional:** mcp-use package in smoke only  

---

## 10. What multi-leg handles today (honest scope)

| Prompt pattern | Handled? |
|----------------|----------|
| Park/lend + farm Blend @ Nx + HF floor | **Yes** (router plan + expand) |
| Deposit + borrow (levered) | **Yes** |
| Single lend / borrow / supply / health | **Yes** (unchanged single-op path) |
| Free-form any strategy (“swap then LP then repay…”) | **Partial / weak** — only if router emits a plan; not full free-form agent yet |
| Cross-product narratives without keywords | **No** — falls back to single intent |

**Not “any multi-leg of any kind.”** Phase 1 = known high-value patterns + expand of levered farm. Phase 2 = smarter planner.

---

## 11. CTO / owner readiness

| Question | Answer |
|----------|--------|
| Ship as finished end product? | **No** — demoable Phase 1, not final assistant product |
| Demo internal / show progress? | **Yes** — park→farm@2× E2E with real hashes |
| Rework MCP? | **Not required** for multi-leg; MCP stays per-leg tools |
| Rework Sign Service? | Only if new op decode gaps appear (Blend deposit already fixed) |
| Copilot polish still needed? | **Yes** — labels, planner coverage, one clean summary after chain, UX |
| Production break risk of this change? | **Low–medium** if only plan path; single-op reads/writes untouched |

---

## 12. Production safety (regression guard)

**Blast radius:** `runPlan` only when `routed.kind === "plan"`.  
Single-op `runRead` / `runWrite` paths are unchanged.

**Safe by design:**
- Expanded legs use `multi_leg: false` so `runWrite` does not double-split and invent client chains on top of server expand
- Fail → stop; never mark later legs success
- HF floor stop is extra safety, not a bypass of MCP/Sign risk
- Auto-sign / wallet still required per leg when policy says so

**Risks to watch:**
- Longer wall time for N legs (timeouts)
- Partial position if leg 2 fails after leg 1 (inherent to multi-tx; honest report)
- Client `next_step` chain still used when a leg returns `needs_sign` — labels must stay clean

**Pre-prod checklist:**
1. Single prompt: “deposit 5 XLM as collateral” still works  
2. Health: “what is my health factor” still works  
3. Multi: park + farm @2× with auto-sign  
4. Multi with auto-sign off: pauses cleanly, no false “all done”  
5. No invent of tx hashes when MCP fails  

---

## 13. Label polish

Agent run titles use product copy, e.g.:
- `Deposit 10 BLUSDC as collateral`  
- `Borrow 10 BLUSDC`  
- `Supply 10 BLUSDC to Blend`  

Not: `Borrow 10 BLUSDC free balance (2× leg 2/3)`.  

