# Session handoff — Vanna copilot, 10 Sep 2026

**For any AI agent** — Claude, Grok, Cursor, GPT. Written so you can continue without this
conversation. Read §3 before acting; §4–6 are the parts you cannot get from the repo.

**Honest opening:** the flagship prompt still does not fully work. Four phases of real
progress, and `can I withdraw 100 XLM without getting liquidated?` returns a partial answer
with a time-budget warning. Do not read the passing test suite as "done".

---

## 1. What this is

An agent-native margin copilot for Vanna on Stellar/Soroban. A user states an objective in
natural language; the system investigates the live account through audited reads, sizes
options in deterministic code, proposes them for approval, executes leg by leg, and verifies
settlement.

**Two repos, one system:**
- App: `C:\Users\akgam\Documents\vanna-copilot-orchestrator` (Next.js/TS) → GCP `vanna-main`
- MCP: `C:\Users\akgam\Documents\vanna_mcp` (Python + a TS sign-service) → GCP `vanna-mcp`

---

## 2. Current state

- **App branch** `copilot-upgrade` @ `ea8c1bd`. `tsc` clean. `npx vitest run` = **1,590 passed / 1 failed / 3 skipped**. The one failure is a known network-flaky live-MCP test (`copilot-brain.test.ts`, "price of XLM") — it fails on network, not code.
- **MCP branch** `copilot-phase-3`, [PR #2](https://github.com/vannafinance/vanna_mcp/pull/2). `python -m pytest tests/ -q` = **559 passed**.
- **Deployed:** `vanna-mcp-server` rev `00089-wkn`, `vanna-sign-service` rev `00047-qn8`, `vanna-connect-gateway` rev `00011-mwr` (unchanged). All green.
- **Test account:** `CBOQAN5NFII4P5HD73M2IRSFYZSXC5XC76FQWQ5JU7LJAO66TFFPG5XY` (wallet `GD4BQR…NPDH`, Stellar testnet).

⚠️ **MCP `main` does not contain what is running in production.** A deploy from `main` would roll back both services. Merge PR #2.

---

## 3. Read these first

| File | What it is for |
|---|---|
| `docs/copilot/HANDOFF-roadmap-v2.md` | **The current plan.** Supersedes `HANDOFF-phase-4-roadmap.md`. |
| `docs/copilot/PROMPT-LIBRARY.md` | Every live prompt result, verbatim, with cause. The flagship prompt has six dated entries showing its whole history. |
| `docs/copilot/diagrams/*.mmd` | Nine Mermaid diagrams. Import via Excalidraw → Mermaid to Excalidraw. |
| `.claude/skills/ship-across-repos/SKILL.md` | How to change both repos together without breaking the contract. |
| `.claude/skills/stress-test-copilot/SKILL.md` | How to run and log live prompts. |
| `scripts/check-mcp-parity.py` | Verifies `catalog.ts` ↔ `LEGACY_TOOL_MAP` ↔ server. Run before every deploy. |
| `docs/copilot/OWNER-collateral-definition.md` | The open product decision. |

---

## 4. Decisions, and why

**The model never produces a number.** It interprets language and chooses what to inspect.
Amounts, safety thresholds and "did this settle" are deterministic code. Every serious bug
here looked the same from outside: the model said something plausible and wrong. Do not
relax this to make something easier.

**Display from the app snapshot; sizing from the contract.** Display must match the Margin
page — a copilot contradicting the page is worse than one slightly stale. Sizing must match
the contract, because consistency with a wrong figure does not prevent a liquidation. When
they disagree beyond tolerance (max $0.50 or 0.5%), **refuse to quote a size** rather than
pick one.

**Postgres, not Redis, for durable state.** Sessions, approvals, execution checkpoints,
standing orders and the audit log reference each other and need querying. Redis serves
approvals-with-TTL well and nothing else. **Firestore is out — the IAM grant was rejected,
do not retry it.**

**Do not migrate to LangGraph.** Considered seriously and rejected. Our loop is
`decide → batch reads → observe → decide` with one branch. LangGraph earns its keep on
graph-shaped problems — conditional edges, multi-agent handoffs, pause-for-days. We have
none. Adding checkpointing to our own loop is ~3–5 days; migrating is 3–6 weeks and risks
1,590 tests plus the domain layer. Standing orders are a cron reading Postgres against a
pre-approved mandate — not a graph problem.

**No inline leg editing.** Conversational refinement in a persistent thread instead. An
editable amount field hands the user a control that breaks the constraint the system exists
to protect, then makes them guess numbers against a solver. **Edit the inputs — floor,
budget, assets, borrow yes/no — never the output amounts.**

**Binding rules.** Reads need no wallet binding (public chain data). Manual-signed writes
need none (the signature *is* the proof). Auto-sign needs one (the Sign Service acts for
you). Coupling all three to one mechanism caused four phases of misleading refusals.

**Keyword `can_withdraw` stays a read-only catalogue name.** Do **not** "align" it to the
live tool name `vanna_margin_trade` — that tool also dispatches `borrow`/`repay`/`settle`,
so aligning would hand the model a write dispatcher. This is a confused-deputy risk.

---

## 5. What was tried and failed

**Two hypotheses about the debt bug were both wrong.** I proposed a missing `BLUSDC` price
zeroing the value, and `Math.max` collapsing tokens. Neither. The real cause:
`get_all_borrowed_tokens` listed `["XLM","USDC"]`, the USDC debt read returned empty,
`allSettled` silently omitted it, and the scan still returned `success: true`.

**A "28m 45s" run never happened.** The UI clock started at page mount and never reset.
A 28-minute run is impossible against a 45s loop budget and a 300s route cap. **Every
latency number before that fix is untrustworthy**, including the 1m 09s that motivated the
original latency plan.

**The generic error hid four distinct failures for three phases.** `investigate/route.ts`
caught, mapped to "I couldn't reach the information needed", and logged nothing. Adding one
`console.error` was the highest-leverage change in the project.

**The same defect class has appeared four times** in different disguises — a failed read
becoming a confident value: partial collateral scan → "HF 0.01"; missing price → $1,021 of
debt erased; empty bindings → "your wallet isn't linked"; normalizer shape mismatch →
"no supported display fields". `lib/usable-read.ts` centralises the fix. **Route new read
sites through it.**

---

## 6. Corrections — where I was wrong

**I flagged a tool-name mismatch as a bug and it was not.** `scripts/check-mcp-parity.py`
compared against `async def` names. `surface_tools.py` registers some surfaces under a
different name via `__name__` override — `vanna_farm_overview_surface` registers as
`vanna_farm_overview`. I "fixed" the app remap to match the function name and **broke a
working path**. An existing test caught it; I initially dismissed the test as stale.
Reverted. **Only the registered name reaches the wire. When a parity check disagrees with a
passing test, assume the check is wrong.**

**I over-reached on the source of truth.** I declared the contract authoritative and the app
wrong from a single unpinned spot-check. Corrected: it is a *definitional* difference, not
an error — see §8.

**I never questioned hand-rolling the agent runtime** across several architecture documents,
and never checked what frameworks already solved. That produced a defensible design that
re-derived standard patterns while missing the standard tooling. The correction is in
`docs/copilot/` and the readiness artifact — adopt telemetry and durable state, keep the
loop.

**I treated observability as a UX nicety.** It is the foundation; see the 28-minute phantom.

---

## 7. In flight right now

**Grok is working the app repo.** Four uncommitted files, all Grok's — do not commit them
yourself:
- `components/copilot/copilot-workspace.tsx`, `components/copilot/session-auto-sign.ts`,
  `tests/lib/session-auto-sign.test.ts` — the Autonomy rail poll and session-status mapper (P0)
- `lib/copilot/investigation/onchain-strings.ts` — new, the on-chain injection defence (M-A)

**MCP repo** has uncommitted work beyond PR #2. Some of it already shipped inside the
deployed image because it sat in the build context — check `git status` before any deploy.

---

## 8. Open questions needing a person

**The collateral definition.** Settled against contract source
(`Protocol_V1_Soroban` branch `testnet` @ `1d333fb`): `get_current_total_balance_internal`
walks only `get_all_collateral_tokens()` — **posted** collateral. The app additionally
counts unposted SAC held in the same margin account.

Ledger-pinned at 4603116: app $1,087.20 / HF **3.90** vs contract $953.80 / HF **3.42**.
Debt agrees exactly, so this is not drift. **Users see a health factor friendlier than the
one that liquidates them.**

Recommendation: show posted, unposted, and compute health from posted — which also lets the
copilot say *"post your unposted balance and health goes 3.42 → 3.90"*. **Do not change the
app maths until the owner decides**; it is load-bearing for Margin and Portfolio.

**MCP CI/CD is broken.** `.github/workflows/deploy.yml` fails at auth — it wants
`credentials_json: ${{ secrets.GCP_SA_KEY }}` and the repo has **no secrets configured**.
Last successful run: never; last attempt 2 Sep. Fix: switch to Workload Identity Federation,
matching the app repo. Needs IAM setup in `vanna-mcp`.

---

## 9. How to work here

- **Commits:** the owner's name only, **one short line**, no AI attribution. Configured via
  `attribution` in `.claude/settings.local.json` for the app repo.
- **Research before recommending.** Web-search how something is built in production now,
  then say where our design falls short — and always return the sources as links.
- **Write the next handoff automatically** after verifying work. Never ask permission to
  write a document.
- **Verify, do not trust.** Run `tsc`, both test suites, and the live app. A green suite has
  coexisted with a broken flagship prompt in every phase so far.
- **Report failures as failures,** with output. Partial work is not complete work.
- **Both auto-sign states.** Every live result so far is auto-approve **ON**. OFF is a
  different code path with its own failure history and is untested.
- Keep summaries short — one or two plain sentences.

---

## 10. The immediate next action

**Run `docs/copilot/HANDOFF-roadmap-v2.md` P0:** confirm the Sign Service deploy completed
the safety fix — the Autonomy card should read **"Budget active"**, not "Budget set —
in-app only". If it still says in-app only, the cause is now app-side or policy-side, not a
missing endpoint.

Then the flagship prompt, five times with auto-approve ON and five with it OFF, logging each
to `PROMPT-LIBRARY.md`.
