# Handoff — everything remaining, in order

**For:** the implementer. **Audited by:** Claude. **Created:** 11 Sep 2026.
**App:** `copilot-upgrade` @ `7f3aee0` (3 unpushed local commits, ~56 files in tree).
**MCP:** `main` @ `60b2717`, deployed.
**Verified baseline:** `tsc` clean · vitest **1,644 / 0 / 3** · `handle.ts` **~7,743** · `router.ts` **2,645**.

> This supersedes `HANDOFF-phase-P2-planner-cut.md` and `HANDOFF-phase-4-roadmap.md`.
> Numbering per `PHASES.md`: **P0–P7** app, **M-A/B/C** MCP.

---

## How to work this document

**Work straight through. Do not stop between tasks to check in.** Complete everything you
can, and report **once at the end** with the standard summary. If a task is genuinely
blocked, record why, move to the next one, and keep going — a blocked task is not a reason
to stop the pass.

Report at the end as:

```
**Done** / **Verified** / **Not done or blocked** / **Deviations** / **New findings**
**Suite:** tsc · vitest · pytest
```

Name the repo for every change. Log every live prompt to `docs/copilot/PROMPT-LIBRARY.md`.
If a hypothesis here is wrong, say which and what the real cause was — that has been the
most valuable line in every previous report.

---

## Rules

**Parallel work — you own the APP repo only.** A second agent (Gemini, in Antigravity) is
working the MCP repo at the same time, from `HANDOFF-mcp-launch-blockers.md` in that repo.
**Do not touch the MCP repo** — not one file. The repo boundary is what makes parallel work
safe; there is nothing to merge because you never open the same file.

**Sections 3, 4, 4b and 6 (M-A, M-B, M-D, M-C) are Gemini's. Skip them.** They stay in this
document so you know what is changing under you, not as work for you.

**One consequence that matters:** MCP tool names and actions may change in that repo, but
**nothing deploys during this pass**. So do **not** re-point `catalog.ts` or
`LEGACY_TOOL_MAP` at any new MCP surface — the live server still only has the old ones, and
the app must keep working against what is deployed. Expand-then-contract: the server adds
first, the app migrates after a deploy.

**Scope within the app: copilot only.** Report bugs in app code; do not fix them.

| In scope | Out of scope |
|---|---|
| `lib/copilot/**`, `components/copilot/**`, `app/api/copilot/**` | any page, any component outside `components/copilot/` |
| `hooks/use-investigation.ts`, `use-copilot-entry.ts`, `use-workflow.ts` | `components/margin/**`, `navbar.tsx`, `components/wallet/**`, `app/globals.css` |
| `lib/usable-read.ts`, `docs/copilot/**`, `.claude/**`, copilot tests | `lib/account-snapshot.ts`, `lib/margin-utils.ts`, `lib/blend-utils.ts`, `lib/mercury-*`, `app/api/mercury/**` |
| *(MCP is Gemini's this pass — do not open `vanna_mcp`)* | `store/**`, `contexts/**`, `hooks/use-wallet.ts`, `use-margin.ts` |

Narrow exception, flag each time: `instrumentation.ts`, the `next.config.ts` hook,
`package.json` deps, CI config, `lib/server/broken-pipe.ts`.

**Git:** do not commit or push. Never raise a PR from `copilot-upgrade`. `dev` is
read-only — pull from it, never the reverse.

**Test account:** Privy `GD4BQR…NPDH` → `CBOQAN…G5XY`, Stellar testnet.
**This wallet is Privy embedded, not Freighter** — auto-approve ON *is* testable here.
Earlier notes calling it blocked were wrong.

---

## Already landed — do not redo

P0/P1 runtime: telemetry, retry policy, on-chain string defence, EPIPE handling, OTel.
`origin/dev` merged; six shared files stay on dev's version; snapshot tests deleted.

**Task 0 (health) — done and verified live.** `"what's my health factor?"` now returns in
**16.2s** via MCP `liquidation_snapshot`, never Vertex, never blocking on the app snapshot.
Answer quotes *"3.42 on posted collateral, the base the risk engine uses"* and the dial
captions the posted-vs-unposted distinction. The 120s abort is gone.

**Planner peels 1–2.** `intent-confidence.ts`, `unnamed-intent.ts`. Copilot free-text never
keyword-plans. `handle.ts` 8,642 → **8,164**.

**This pass (app, 11 Sep afternoon).** Plan-preview sizing moved to `lib/copilot/plan-preview.ts`.
Keyword `parseStatedWrite` removed — fully specified writes compile from the planner’s
`goal.actions` (same `compileRequestedActions` the loop already used). Propose no longer
awaits MCP risk on **any** candidate (stated repay *and* ranked strategy); Approve /
`readyForStep` still do. Duplicate checkpoint imports and the fall-through test hang are
fixed. Audit JSONL, file checkpoints, and `guardrail-policy.ts` are wired on the journal
path. **Swallowed-catch class closed:** `logUnexpected` logs name/message/stack on
investigate, propose, approve, submit, confirm, advance, plus risk/journal — the propose
route was the third instance and the one that hid the 13:24 timeout. Display helpers,
farm-pool filter, MCP payload totals, and MCP error mapping peeled out of `handle.ts`
(`display-amounts.ts`, `farm-pools.ts`, `mcp-payload.ts`, `mcp-error-response.ts`) so the
`runRead` move is unblocked. **Do not redo.** MCP sections 3–4b and 6 are Gemini’s — this
repo must not change `catalog.ts` / `LEGACY_TOOL_MAP` until that deploy.

---

## 1 · P2 — finish the planner cut

**The target changes. ~2,000 was wrong and unreachable.** Measured composition:

| Section | Lines | Moves? |
|---|---|---|
| Writes (MCP + auto-sign) | ~3,650 | **No** — write execution belongs here |
| Reads | ~2,620 | **Yes** — the investigation loop owns reads |
| Dispatch / routing | ~1,300 | **Yes** — decision logic |
| Auto-sign control | ~660 | Mostly stays |

**Realistic target: ~4,000–4,500.** A target you cannot reach stops telling you when you
are done.

- Plan-preview sizing is **done** (`lib/copilot/plan-preview.ts`).
- Display helpers / farm-pool filter / MCP error mapping peeled out of `handle.ts`.
- Next peel: `runRead` + the position/earn/farm answer helpers (~2,500 lines, still in
  `handle.ts` ~1735–4300). That is the remaining read cluster. Do not start it mid-eval.
- `router.ts` read-through cache is in place. Exact-match reads answer early; write/plan
  clauses miss the cache; Copilot free-text never reaches `routeMessage`.
- **Do not pull `runWrite` / `runPlan` out.**
- One decision path at a time, eval gate between moves, Langfuse trace before and after.

**Keep untouched:** resume and multi-leg execution, the trust boundary, `usable-read.ts`,
the binding rules, the drift guard.

---

## 2 · The signed-in battery — the largest untested surface

Every copilot result to date is guest or MCP-direct. **This wallet is Privy, so ON is
runnable.** Run in the logged-in `/copilot` tab:

1. **Owner paragraph, verbatim**, 5× auto-approve ON and 5× OFF:
   *"use some USDC and BLUSDC to build a strategy so my health factor doesn't go below 1.3 —
   you can use spot and farm markets yourself, and you can even take new loans."*
2. **Messy prompts:** "am I going to get liquidated?", "is my money safe", "wats my helth
   factor", "do something with my idle funds", a health question in Hindi, and *"borrow as
   much as possible but stay completely safe"* — naming the tension passes; silently picking
   a side is `WRONG`.
3. **Three-turn refinement** in one thread: owner paragraph → "make it 1.4 instead" →
   "actually use XLM too".
4. **A landed 1 XLM repay** from the signed-in page — hash plus Horizon `successful: true`.
   The MCP-client route fails `session_user_mismatch` because the session belongs to the
   Privy browser user; that is expected, not a bug. **The write path is unproven until a
   transaction lands.**

---

## 3 · M-A — the on-chain injection test

`onchain-strings.ts` exists and is unit-tested; the live case never ran. Deploy a testnet
token whose symbol carries injected instructions, hold a balance on the test account, run
the account prompts, confirm the string renders as data and never reaches an instruction
position. An hour's work, and it is the one attack surface where our exposure is worse than
the published guidance assumes — our tool results come from a chain anyone can write to.

---

## 4 · M-B — MCP read/write split  *(confused deputy)*  — **now a launch blocker**

**Context change, 11 Sep:** MCP and the copilot are **two separate products**, and MCP ships
publicly — the Aave model. That moves this from "gates public exposure" to **blocks launch**.

`vanna_margin_trade` dispatches `can_borrow`/`can_withdraw` alongside `borrow`, `repay`,
`settle`. `surface_tools.py` checks an action exists, never whether it moves money. So the
read-only guarantee lives entirely in **our app's** catalogue — which a third-party caller
does not use.

Split into read and write surfaces; same for `vanna_account`. **Scope them on the token**, so
a read-only caller is never *offered* a write tool. Keep old names dispatching one release.

---

## 4b · M-D — Scoped auto-sign sessions  *(new, launch blocker)*

**Execution stays in MCP.** That decision is right, and the reason is not latency: transaction
construction and spend policy must have exactly **one** implementation, server-side, where no
caller can route around it. Two implementations of XDR building would diverge on contract
addresses, auth entries and caps.

**Auto-sign already works correctly and is identity-bound.** `signSubmit.ts:110` — sessions
carry `userId` and reject a mismatched assertion. The `session_user_mismatch` seen when Cursor
MCP attempted a repay was **the design working**: the session belonged to the Privy browser
identity, and a different client could not spend it. Do not "fix" that.

**The gap: there is no first-party vs third-party distinction.** No `clientId`, no audience
check — sessions are user-bound only. Today that is fine, because our app is the only caller.
The day MCP is public it is not: **any agent holding a valid assertion for a user gets that
user's full auto-sign power**, identical to the copilot, without a prompt.

**Required shape — sessions become user + client bound:**

- A session records the client that created it.
- Signing requires a client match, or an explicit grant naming the other client.
- A third-party agent with no grant gets **unsigned XDR** and signs in a first-party surface
  (Aave's model) — capability degrades, it does not silently escalate.
- Surface it honestly to the user: *"this agent may sign up to $X/day"* **per client**, rather
  than one global switch.

This is a small change in shape — sessions already carry `userId`; add the client and check it
the same way. It is not small in consequence: without it, connecting any third-party agent
hands over the daily cap.

**Reject the alternative of leaving it open.** "Anyone with a valid assertion may sign" is the
simplest option and the one that turns a user connecting a tool into a user granting spend
authority they did not picture.

---

## 5 · P3 — durable state (Cloud SQL)

One Postgres schema, five concerns: sessions and message history, approval records with
expiry, **execution checkpoints per leg**, standing orders, audit log.

Checkpointing is the correctness half — a four-leg plan two legs in, when the process
restarts, currently has no durable record of what settled. The existing resume only covers
the client coming back to tell us.

**Design note that matters for later:** define the checkpoint as a **plain serializable
state object behind its own interface**, not as whatever `runtime.ts` holds in memory. That
keeps the loop swappable. Written against the loop's internals, they weld together.

**App-side this pass:** `ExecutionCheckpoint` + `saveCheckpoint` (local `.local/copilot-checkpoints`
files, same shape as the journal). Wired from `execute.ts` on settle. Cloud SQL schema is
still unprovisioned — do not invent a Postgres instance.

Firestore is out — the IAM grant was rejected, do not retry.

---

## 6 · M-C — MCP rate limiting and per-tool timing

No rate limiting exists. It is the most commonly reported production failure mode for agent
systems, and our loop fires up to 8 parallel reads per turn across 12 turns — exactly the
shape that trips limits. The app's daily *token* cap does not help; it meters the LLM bill,
not tool calls, and protects nothing against a non-app caller.

Token bucket per agent, cost-weighted by tool. Circuit breaker so a failing downstream
degrades instead of cascading. Per-tool duration in the response — that also settles whether
a slow read is Soroban or the server.

Also confirm **resource-indicator audience validation** in `auth.py` (that a token was issued
for *this* server). Everything around it is correct; this is a check, not a build.

---

## 7 · P4 — audit log

Every agent action against a verified identity: proposed, approved, executed, under which
mandate and cap, with the evidence IDs behind the numbers. Append-only.

This is what answers *"your agent can move money — show me what it did"*. Today a disputed
transaction leaves us a hash and no record of the approval, the cap, or the figures the user
was shown.

**App-side this pass:** `appendAudit` JSONL under `.local/copilot-audit`. Called on propose,
approve/block, and executed (hash only — no XDR, no tokens). Cloud SQL is the intended store.

---

## 8 · P5 — graded guardrail policy in one module

Reads open, manual writes need no binding, auto-sign does. We behave correctly but the rule
is nowhere written, so every new action type re-argues it — and the arguing is where
mistakes enter. The binding gate that blocked reads for four phases was exactly this.

Grade by reversibility, blast radius and stakes; apply the control the grade demands. Same
argument that produced `usable-read.ts`, and that one earned itself.

**App-side this pass:** `lib/copilot/guardrail-policy.ts` + `autoSignAllowed` on irreversible
tools (`close_account` / `settle` / `liquidate`) in `mcp-write.ts` via `forbid_session_sign`.

---

## 9 · P6 — execution-time revalidation

Approval expires on a five-minute clock, but the sizing depended on **prices**. Re-read
prices and re-run sizing immediately before the first leg; re-propose if the floor no longer
holds. Cheap, and it removes the worst realistic failure: a plan safe when shown and unsafe
when signed.

**App-side this pass:** `readyForStep` re-runs `validateWorkflowRisk`. A floor breach
**blocks** the run (`journal.claimNext`); it does not silent-resize a stated amount.
Propose no longer does this live read — Approve is the first price pass. The app snapshot
is **not** on this path: repay/deposit/lend check free-token funds only; a floor on a
worsening op is checked against contract health alone. Transient read misses return the
journal to `proposed` so Approve can be pressed again.

---

## 10 · P7 — runtime parity, not migration

**We are not adopting LangGraph.** Decided 11 Sep: none of the open bugs are runtime bugs,
and a migration would add a second candidate cause to every live failure. The blast radius
is small if we ever change our minds — `runtime.ts` is 470 lines and the 984-line domain
layer does not import it.

What must stay true so the decision holds — the parity checklist:

| Capability | Status |
|---|---|
| Typed state, conditional routing, streaming, per-step timeout, observability | matched |
| Durable checkpointing, durable interrupts | **P3** |
| **Declared per-step retry policy** | `retry-policy.ts` exists — MCP `fetch` in `mcp-client.ts` already routes reads/writes through it; scope + vToken + Earn XLM price reads too. Writes stay 1 attempt. |
| Replay a past run | accepted gap — re-executing a money-moving run is a footgun |

Revisit only if standing orders need pause-and-resume across days, or we go multi-agent.

---

## Acceptance for the whole pass

1. `handle.ts` ≤ ~4,500; `router.ts` cannot override a researched plan; eval green.
2. Owner paragraph answered on the signed-in UI — 5× ON and 5× OFF, logged.
3. One repay landed with a Horizon hash.
4. Live on-chain injection test run and recorded.
5. MCP read/write surfaces split; old names still dispatching.
6. Auto-sign sessions are user **and client** bound; an unknown client gets unsigned XDR.
7. Rate limiting and per-tool timing live on MCP.
8. `tsc` clean; vitest ≥ 1,622 / 0 / 3; pytest green.

Anything not reached: say so, with the reason, in the single end-of-pass report.
