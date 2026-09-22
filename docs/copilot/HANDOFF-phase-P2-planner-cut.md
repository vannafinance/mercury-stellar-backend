# Handoff — P2: the planner cut, inside a hard scope boundary

**For:** the next implementer. **Updated:** 11 Sep 2026 12:15 IST.
**App:** `copilot-upgrade` @ `7f3aee0` (ahead 3 of origin; work left in the tree, not committed).
**MCP:** live tools via Cursor `user-vanna-finance`. Test account **Privy** `GD4BQR…NPDH` → `CBOQAN…G5XY`.

> **Numbering:** canonical scheme is P0–P7 + M-A/B/C — see `PHASES.md`. This is **P2**.
> The production-readiness artifact calls telemetry "P5"; that maps to **P1** here.

---

## 0. Rules — read these first

**Scope: copilot only.** The website, its pages, and shared app libraries belong to the app
developer. **Report bugs there; do not fix them.**

| In scope | Out of scope |
|---|---|
| `lib/copilot/**`, `components/copilot/**`, `app/api/copilot/**` | any page, any component outside `components/copilot/` |
| `hooks/use-investigation.ts`, `use-copilot-entry.ts`, `use-workflow.ts` | `components/margin/**`, `navbar.tsx`, `components/wallet/**`, `app/globals.css` |
| `lib/usable-read.ts`, `docs/copilot/**`, `.claude/**`, copilot tests | `lib/account-snapshot.ts`, `lib/margin-utils.ts`, `lib/blend-utils.ts`, `lib/mercury-*`, `app/api/mercury/**` |
| the whole `vanna_mcp` repo | `store/**`, `contexts/**`, `hooks/use-wallet.ts`, `use-margin.ts` |

**Narrow exception, flag it every time:** `instrumentation.ts` (Next.js requires repo
root), the `next.config.ts` hook, `package.json` deps, CI config, and process-level
handling like `lib/server/broken-pipe.ts`. Runtime, not website. Keep minimal.

**Git:**
- **Do not commit or push** unless asked. Leave work in the tree and say what changed.
- **Never raise a PR from `copilot-upgrade`** — to anything, unless asked by name.
- **`dev` is read-only.** Pull from it (`git merge origin/dev` while on our branch), never
  the reverse. Never `git checkout dev`.

**Signing for this test account is Privy embedded.** Auto-approve ON is the Privy session
(`5b656fcd-…`, $1000/$1000, expires 2026-09-17). Do **not** treat Freighter as the blocker
for this wallet. Freighter still exists in product copy for other wallets; this account
does not use it.

---

## 1. What already landed (do not redo)

**`origin/dev` was merged into `copilot-upgrade`, locally.** Six shared files stay on
dev's version. Copilot-side snapshot patches live in `docs/copilot/app-team/`. **Do not
re-apply them.** Snapshot tests that imported removed app exports were **deleted**.

**P0/P1 runtime:** telemetry, retry policy, on-chain string defence, EPIPE handling, OTel
bootstrap.

**Planner peel 1 (11 Sep morning):** `lib/copilot/intent-confidence.ts`. Copilot free-text
never keyword-plans (`investigation_owns_planning`). Assistant writes/plans/`enable auto-sign`
redirect before Vertex.

**Task 0 — health (11 Sep):** Health questions read MCP `liquidation_snapshot` (cancellable,
8s cap) in parallel with a bounded snapshot wait. Never Vertex a pure health ask. Investigate
75s deadline starts at POST entry. Dial caption: 1.10 is posted; workspace still feeds the
page figure (`basis="page"`).

**Display rule (owner, 11 Sep):** Margin-page HF is the website number when **debt** agrees
with the contract. When debt disagrees, quote posted HF and refuse the panel number
(`page_debt_mismatch`). When the snapshot is still loading, quote posted only — do not tease
"the page can read higher".

**25.50 was load lag, not dropped-leg.** The dial flashed **25.50** then settled to **3.89**.
Posted from the contract is **3.42**. That is the intended posted vs unposted gap
(documented ~3.42 vs ~3.90), not a 25.50 vs 3.42 mismatch. Keep the mismatch refuse for a
real debt disagreement; do not treat that screenshot as the bug.

---

## 2. Task status (this is the whole phase)

### Task 0 — Health questions must not block on the app snapshot — **done**

Live signed-in `"what's my health factor?"` after the fix: **16.2s**, not the 120s client
abort. Server log `request_id=6b5d99e1`:

| Phase | ms | Note |
|---|---|---|
| `scope` | **13,122** | `scope_cache` **miss** — first resolve of GD4B → CBOQAN |
| `vanna_get_liquidation_snapshot` | **2,619** | C `$953.28` / D `$278.77` → posted HF **3.42** |
| `health_fast_path` | 2,621 | includes that MCP call |
| `investigate done` | **16,176** | no Vertex, no unbounded snapshot wait |

Dial later settled to **3.89** (page / unposted). Copilot answer quoted **3.42 on posted
collateral**.

### Task 1 — Cut the planner — **in progress**

| File | Handoff start | Now | Target |
|---|---|---|---|
| `handle.ts` | 8,717 | **8,164** | ~2,000 |
| `router.ts` | 2,645 | **2,534** | read-through cache |

**Peel 2 (11 Sep afternoon):** unnamed-surface Vertex + keyword venue corrections + LLM
plan promotion moved to `lib/copilot/unnamed-intent.ts` (`resolveUnnamedIntent`). Copilot
and assistant-write still never reach it. `handle.ts` now calls that function, then
automation-gap / assistant second gate / plan preview / **write execution**.

**Do not pull `runWrite` / `runPlan` out.** Next peel is the next **decision** path still
inside `handle.ts` (plan-preview sizing is a candidate), eval gate between moves.

Eval this peel: `unnamed-intent.test.ts` + keyword coverage + assistant gate + health
fast-path — **64 passed**. `tsc --noEmit` clean.

### Task 2 — Close P1: read a trace — **partial (health + price named; strategy not in Langfuse window)**

Langfuse v4.33.0 on `:3100`. OTLP `401` without Basic, `200` with. Read path:
`GET /api/public/v2/observations` (`GET /api/public/traces` is 404 in events_only).

| Trace | Prompt | Total | Dominant | Fraction |
|---|---|---|---|---|
| `9200832d` guest | `"what is the price of XLM?"` | 38.7s | `generate_content gemini-3.7-flash` **26.1s** | **67%** |
| `77af5838` signed-in | same price prompt | **686ms** | `vanna_get_price` **660ms** | **96%** |
| `6b5d99e1` signed-in health | `"what's my health factor?"` | **16.2s** (server log) | **scope resolve 13.1s** | **81%** |

Price fast-path skips scope/position on purpose. Health **does** resolve scope; first hit
after process start is a cache miss. Position seed is skipped on the health fast-path
(`health_fast_path` returns before `computeAccountPosition`).

This afternoon the observations API's recent pages were Next.js HTTP spans
(`/api/analytics/accounts`, `/api/account/[addr]`), not copilot/Vertex. Use the **dev log**
`[copilot] investigate` / `investigation phase` lines when Langfuse is HTTP-noise.

**Do not invent a client-supplied HF cache.** Next lever if you apply one: make **scope
resolve** cheaper or sticky (it is 81% of the signed-in health turn). `/api/account` 6–96s
is still the app snapshot, out of scope.

A **signed-in strategy** Langfuse trace (owner paragraph) was **not** captured this pass —
no browser driver for `/copilot`, and guest `POST /api/copilot/investigate` does not count.

### Task 3 — Signed-in battery — **Privy ON confirmed; UI 5×5 and landed repay still open**

**Not Freighter.** Wallet `GD4BQR…NPDH` is Privy. `vanna_sign` `session_status`:
`enabled: true`, caps $1000/$1000, expires 2026-09-17.

Cursor MCP (`user_01KX5T71JJ7PY4RVV06K9SW04E`) **is bound** to that G-address. Reads work.
A 1 XLM repay from this MCP client **simulated** (`simulation_success: true`) then
**auto-sign rejected** `session_user_mismatch: session was created by a different user`.
Nothing landed. No hash. Horizon not called. The session belongs to the **Privy browser
user**, not the Cursor MCP assertion. Land the repay from **signed-in `/copilot`**, not
from this chat's MCP tools.

This agent cannot type into the user's `/copilot` tab. Owner paragraph 5× ON / 5× OFF,
messy prompts, and three-turn refinement are **not run** on the page. MCP read battery
this afternoon is logged in `PROMPT-LIBRARY.md`.

---

## 3. What is still yours

1. **Keep peeling `handle.ts`** toward ~2,000. Decision paths only. Eval between moves.
2. **Fire a signed-in strategy** on `/copilot` with auto-approve ON, then name the Langfuse
   (or `[copilot] investigate`) dominant span with a number.
3. **Battery on the page** (Privy, auto-approve ON then OFF): owner paragraph 5× each,
   messy set, three-turn refinement, **1 XLM repay** until Horizon `successful: true`.
4. Do not re-open Task 0 unless health hangs again. Do not call 3.42 vs 3.89 a bug.

---

## 4. Live numbers (do not invent; 11 Sep 12:10 IST)

- Oracle XLM: **$0.1762532742473**, `is_stale: false`
- Posted C/D: **$953.28 / $278.77** → HF **3.42**, `liquidatable: false`
- Page dial after hydration: **~3.89**
- Earn XLM supply APY: **5.181981%** (not Blend)
- Blend XLM supply APY: **420.39%** (Farm only — different venue)
- `can_withdraw` 100 XLM: **allowed**
- `can_borrow` 10 XLM: **allowed**
- XLM debt still on the account: **119.37 XLM** (repay 1 XLM is in range)

---

## Acceptance

| # | Criterion | Status |
|---|---|---|
| 1 | `handle.ts` materially smaller; router cannot override a researched plan; eval green | **smaller (8,164, not 2,000)** · router docs + copilot gate hold · 64 tests green |
| 2 | `tsc` clean without restoring app-side snapshot exports | **clean** this pass |
| 3 | Langfuse (or equivalent) dominant cost named with a number | **yes** — health scope 13.1s / 81%; price traces earlier |
| 4 | Copilot refuses to size when app and contract **debt** disagree | **unit-tested**; live 25.50 was **not** this case |
| 5 | Auto-approve testable or recorded as blocked, with the reason | **testable on Privy `/copilot`**; Cursor MCP submit **blocked** (`session_user_mismatch`) |
| 6 | No file outside the in-scope column touched this pass | copilot + docs only. Pre-existing staged `lib/account-snapshot.ts` / `lib/margin-utils.ts` **not edited here** |

---

## Report back (this pass)

**Done:** Task 0 (already live) documented correctly; peel 2 `unnamed-intent.ts`; Freighter
blocker removed from P2 docs; 25.50 recorded as hydration lag → 3.89; MCP read battery;
repay attempted from Cursor MCP.

**Verified:** `tsc --noEmit` clean · vitest **64 / 0** (unnamed-intent, keyword coverage,
assistant gate, health fast-path, answer, health-dial) · health 16.2s live · auto-sign
session enabled for GD4B.

**Not done:** `handle.ts` still ~8k; signed-in strategy Langfuse; `/copilot` 5×5; Horizon
`successful: true` on 1 XLM repay.

**Deviations:** Task 3 repay run from Cursor MCP instead of the page — expected
`session_user_mismatch`. Langfuse observations window had no copilot spans; used the
dev log for health.

**New findings:** Signed-in health cost is **scope resolve**, not Vertex and not
`GET /api/account`. MCP error copy still says "Sign it in Freighter/wallet" on an unsigned
envelope even for this Privy account.

**Suite:** tsc clean · vitest 64 targeted (full suite not re-run) · pytest not run (no MCP
code change this pass).

Log: `docs/copilot/PROMPT-LIBRARY.md`. **No commit.**
