# System changelog — Copilot + Multi-leg agent

Living log of upgrades on branch `copilot-assistant`.  
**Mirror:** Notion pages under Copilot tracker / MCP tracker (see links at bottom).

---

## Status snapshot (2026-08-02)

| Area | Status |
|------|--------|
| Multi-leg agent (mcp-use *pattern*, not package) | **Shipped** (Phases 1–3) |
| Strategy UI card | **Shipped** |
| Preflight (wallet lend balance, account) | **Shipped** |
| Resume remaining legs | **Shipped** |
| Planner breadth (repay→deposit, swap→farm, …) | **Shipped** |
| Privy create/save copy + toast | **Shipped** (light) |
| Production canary deploy | **Deferred** (by product choice) |
| Streaming live steps | **Next slice** (not started) |
| Free-balance preflight before Blend supply | **Next slice** (not started) |

**Branch:** `copilot-assistant` (ahead of origin; push when ready)  
**Commits:**
- `390cebe` — multi-leg agent + production-ready strategy UI  
- `b9867be` — preflight, resume, broader plans, Privy polish  

---

## What “next slice” means

### Next slice A — **Streaming step progress** (recommended next)
**Problem:** Multi-leg waits until all legs finish (or stop) before the UI updates. Long runs feel frozen.  
**What it does:** Stream progress as each leg starts/ends so the strategy card shows *Running → Done/Fail* live.  
**Touches:** `/api/copilot` (SSE or chunked), `handle.ts` / `runPlan`, `copilot-workspace.tsx`  
**Does not change:** MCP tools, Sign Service policy, on-chain semantics  

### Next slice B — **Deeper preflight (free C-balance / farm)**
**Problem:** Lend preflight exists; farm legs can still fail late if margin free balance is missing after borrow.  
**What it does:** Before `supply_to_blend`, check free balance in the smart account (or warn after borrow if HF/balance looks wrong).  
**Touches:** `multi-leg-preflight.ts`, MCP reads (`collateral` / free balance if exposed)  
**Does not change:** MCP write contracts unless a new read action is needed  

### Later slices (ordered)
| Slice | Does |
|-------|------|
| Soft network retry (1×) | Auto-retry `fetch failed` once per leg |
| Idempotent resume | Skip legs already on-chain by hash/op fingerprint |
| Free-form planner v2 | More than keyword templates; stronger Vertex plans |
| Streaming + cancel | User can stop mid-strategy |
| Canary deploy | Push + existing Cloud Run (no new GCP project) |

---

## Test prompts (copy/paste into `/copilot`)

### Core multi-leg (happy path)
```
park 20 XLM for yield then farm 10 BLUSDC at 2x keep HF above 1.4
```
**Expect:** Strategy card · 4 legs (lend → deposit → borrow → supply) · Done + hashes if auto-sign on · HF floor chip.

### Preflight — insufficient wallet
```
park 999999 XLM for yield then farm 10 BLUSDC at 2x
```
**Expect:** Blocked at preflight · no on-chain txs · clear balance message.

### Resume
1. Run core multi-leg; force a mid fail (e.g. kill network briefly) **or** use small/odd size that fails.  
2. Click **Continue remaining (N)** on the strategy card.  
**Expect:** Only failed/skipped legs re-run; Done legs not re-claimed.

### Broader planner
```
repay 5 BLUSDC then deposit 10 XLM as collateral
```
**Expect:** `kind: plan` with repay → deposit_collateral (not single repay only).

```
swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC
```
**Expect:** Plan with swap + levered farm expand.

### Regression (must still be single-op)
```
deposit 5 XLM as collateral
```
```
what is my health factor
```
**Expect:** Normal single write / single read — not multi-leg card.

### HF floor (do not steal amount)
```
park 20 XLM then farm 10 BLUSDC at 2x keep HF above 1.4
```
**Expect:** Amounts 20 and 10 — **never** amount 1.4.

### Auto-sign off
Disable auto-approve, then core multi-leg.  
**Expect:** Pause for sign · card shows Needs sign · later legs pending · no false “all done”.

---

## Change log (chronological)

### 2026-08-02 — Session log grouping for multi-leg (UI)

**Problem:** Client `next_step` chain logged each hop as a separate session turn  
(`Lend…`, `Deposit…`, `Borrow…`) plus the original prompt — looked like step 1 ran twice.

**Fix (UI only):**
- Session log groups multi-leg / agent-chain under **one parent row** (`strategy`)
- Nested legs list under the parent (done / staged / skip)
- Header keeps original user prompt during hops (not only “Borrow 10 BLUSDC”)
- Wallet-sign + `pending_write` hops update the parent instead of new turns

**Files:** `components/copilot/copilot-workspace.tsx`

### 2026-08-02 — Multi-leg agent core + UI (`390cebe`)
**Copilot**
- `lib/copilot/multi-leg-agent.ts` — expand, labels, report, humanize errors, UI data  
- `lib/copilot/handle.ts` — `runPlan` MultiLegAgent loop, HF sample/stop  
- `lib/copilot/plan-sanitize.ts` — HF floor never amount; prefer keyword multi-goal  
- Strategy card in `copilot-workspace.tsx`  
- API `maxDuration=300`, multi-leg logging  
- Tests: `npm run test:multi-leg`  

**MCP**
- No protocol rewrite  
- Client: better network/timeout errors; session reuse (existing)  
- Sign Service Blend deposit decode was prior work (still required for farm supply)

### 2026-08-02 — Preflight + resume + planner breadth (`b9867be`)
**Copilot**
- `lib/copilot/multi-leg-preflight.ts` — lend balance + account checks  
- `resume_multi_leg` on API + handle + **Continue remaining** button  
- Router: multi-goal **before** single repay/deposit; more patterns  
- Privy modal + create toast with short address  

**MCP**
- Still no new tools required  
- Preflight uses existing `vanna_get_wallet_balance` via lend preflight helpers  

---

## Architecture (reminder)

```
User prompt → Router / Vertex → plan steps
    → expandPlanWrites (2× farm → 3 legs)
    → preflightExpandedLegs
    → for each leg: runWrite (MCP + Sign) → HF sample → stop rules
    → multiLegUiData → Strategy card (+ resume_legs)
```

- **Copilot** = brain (intent, plan, loop, UI)  
- **MCP** = tools (reads/writes)  
- **Sign Service** = auto-sign / submit  

mcp-use: **pattern only** (multi-step loop). Not installed in prod.

---

## Notion mirrors

| Doc | URL |
|-----|-----|
| **Copilot — Multi-leg agent progress** | https://app.notion.com/p/3b08802ec23c8147b902d32bded01a31 |
| **MCP — Multi-leg notes** (Copilot tracker) | https://app.notion.com/p/3b08802ec23c81888ecdf6a8d0013a0e |
| **MCP — Multi-leg notes** (MCP tracker) | https://app.notion.com/p/3b08802ec23c81b9a148db712eddefc3 |
| Parent: NOTION_COPILOT_TRACKER | https://app.notion.com/p/39d8802ec23c804a8acfecfa33a5ce59 |
| Parent: NOTION_MCP_TRACKER | https://app.notion.com/p/39d8802ec23c80bcbc7cc532c4092509 |

---

## How to maintain this file

When shipping a slice:
1. Add a dated section under **Change log**  
2. Update **Status snapshot**  
3. Add/adjust **Test prompts**  
4. Sync the same bullets to Notion Copilot + MCP docs  
