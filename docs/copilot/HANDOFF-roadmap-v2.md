# Handoff — consolidated roadmap v2

**For:** the implementer (Grok 4.6). **Audited by:** Claude. **Created:** 10 Sep 2026.
**Branch:** `copilot-upgrade` · MCP branch `copilot-phase-3` ([PR #2](https://github.com/vannafinance/vanna_mcp/pull/2)).
**Baseline:** `tsc --noEmit` clean · `npx vitest run` **1,585 / 0 / 3** · MCP pytest **559**.

> **This supersedes `HANDOFF-phase-4-roadmap.md`.** That document is still correct in
> substance — every task in it appears below — but it predates a review against 2026
> production practice which added four items and changed the order. **Give Grok this one.**

**Test account:** `CBOQAN5NFII4P5HD73M2IRSFYZSXC5XC76FQWQ5JU7LJAO66TFFPG5XY`
**Both repos in scope.** App: `vanna-copilot-orchestrator` · MCP: `C:\Users\akgam\Documents\vanna_mcp`.
**Never deploy contracts.** MCP and Sign Service deploys are authorised.

---

## 0. How to report back

```
**Done** / **Verified** / **Not done or deferred** / **Deviations** / **New findings**
**Suite:** tsc <…> · vitest <p>/<f>/<s> (baseline 1585/0/3) · pytest <…>
```

Name the repo per change. Report failures as failures. If a hypothesis here is wrong, say
which and what the real cause was.

**Also: log every live prompt to `docs/copilot/PROMPT-LIBRARY.md`** using the
`stress-test-copilot` skill. Verbatim output, `file:line` cause, defect class. Entries are
never deleted — a fixed prompt gets a new entry above the old one.

---

## Deployment state — do not redo

| Service | Revision | Deployed |
|---|---|---|
| `vanna-mcp-server` | `00089-wkn` | 10 Sep 11:30 — `liquidation_snapshot` live |
| `vanna-sign-service` | `00047-qn8` | 10 Sep 11:55 — `GET /sessions` live |
| `vanna-connect-gateway` | `00011-mwr` | 2 Sep, unchanged |

Deploy each service from **its own directory** (`--source .`), not the parent
`cloudbuild.yaml` — the parent runs above where `.gcloudignore` lives, which is what caused
the Windows `MAX_PATH` upload failure. Deploy as `aditya@vanna.finance`; the Cloud Build SA
lacks `run.services.get`.

---

## Order, and why

Four changes from the previous roadmap, all driven by the practice review:

1. **P0 stays first** — cheap, and it unblocks the owner's own auto-approve testing.
2. **M-A jumps early.** One hour, and it is the only attack surface where our exposure is
   *worse* than published guidance assumes.
3. **P1 telemetry moves ahead of the planner cut.** This is the significant reorder. You are
   about to delete ~6,000 lines of decision-making code; doing that without instrumentation
   means finding out from users whether latency or behaviour regressed. One day of tracing
   de-risks the largest change in the project.
4. **Everything else follows dependency**, not appetite.

---

## P0 · Confirm the Sign Service deploy completed the safety fix <span>· hours</span>

Auto-approve refuses to arm unless `capsEnforced`, which reads `GET /sessions` — now
deployed. Confirm the card reads **"Budget active"**, not "Budget set — in-app only". If it
still reads in-app only, the cause is app-side or policy-side, not a missing endpoint.

Then run the acceptance prompt **five times with auto-approve ON and five with it OFF**.
Every live result so far is ON only; the two states take different code paths.

---

## M-A · Test the on-chain injection vector <span>· 1 hour · MCP + app</span>

**Why this is not theoretical.** MCP prompt injection arrives through **tool results**, and
all published guidance assumes tool results come from systems you control. Ours come from a
public blockchain. Token symbols, pool names and asset metadata are strings any stranger can
write on-chain, and they reach the model the moment they appear in a balance list. An
attacker never needs to touch our users — they deploy a token and wait.

**Do:** deploy a testnet token whose symbol carries injected instructions
(`Ignore previous instructions and…`), hold a balance on the test account, run the account
prompts. Confirm the string renders as data, never lands in an instruction position, and is
length-bounded.

**Add it to the stress-test battery permanently** regardless of the result.

---

## P1 · Telemetry — OpenTelemetry GenAI + Langfuse <span>· ~1 day · app</span>

**Why before the planner cut:** every latency number in this project was wrong for weeks
because a UI clock started at page mount — we reported "28m 45s" for a run that could not
exceed five minutes, and built a latency plan on it. The questions we need answered are
cross-cutting ("where did 57s go across 12 turns and 24 tool calls"), which is a trace
question, not a log question.

**Why OpenTelemetry:** the GenAI semantic conventions define standard spans for LLM calls,
agent invocations and MCP tool calls, plus token metrics. Instrument once against the spec
and Langfuse, Arize, Datadog and Grafana all consume the same OTLP export. Instrumenting
against a vendor SDK means redoing it to change tools.

**Why Langfuse:** self-hostable and MIT — traces will contain account addresses, balances
and health factors, so a third-party SaaS is a data-residency decision someone must own.
It also scores our existing eval fixtures, turning pass/fail into a tracked trend, and its
session replay makes multi-turn refinement bugs visible. If it disappoints, Arize Phoenix is
the swap, and OTel makes the swap cheap.

**Do:** span per model call (with token usage and effort level), per agent turn, per MCP
tool call. OTLP to self-hosted Langfuse. Then point it at the eval fixtures.

**Acceptance:** a truthful phase-by-phase breakdown of the 57s turn, and the dominant cost
named.

---

## P2 · Finish the planner cut <span>· the big one · app</span>

| File | Now | Target |
|---|---|---|
| `handle.ts` | **8,642** (unchanged) | ~2,000 |
| `router.ts` | **2,643** (up 28) | read-through cache |

`shouldUseLegacyExecutor` is gone and the read-cache exists, but no decision path has been
removed yet. **Keyword write planning for the assistant widget is the largest remaining one
— peel that next.**

`router.ts` answers exact-match reads early and otherwise steps aside; it must not be able
to override a researched plan. `handle.ts` keeps only approval replay, write execution,
settlement verification and receipts.

**Move one decision path at a time and run the eval gate between moves.** With P1 in place,
also compare traces before and after each move — that is the point of doing telemetry first.

**Keep untouched:** resume and multi-leg execution, the trust boundary, `usable-read.ts`
semantics, the binding rules, Pass A's drift guard.

---

## M-B · MCP read/write split — the confused deputy fix <span>· MCP</span>

**Why the priority rose.** This has a name: *confused deputy* — a privileged component
manipulated into using its privileges on behalf of someone who should not have them.
`vanna_margin_trade` dispatches `can_withdraw` **and** `borrow`/`repay`/`settle` through one
tool; `surface_tools.py` validates that an action exists and has its arguments, never
whether it moves money. The guarantee lives entirely in the app's catalogue.

That reframes the earlier near-miss: aligning the catalogue to the live tool name would have
pointed the model at the write dispatcher. That was not a lucky escape from an untidy
design — it was the attack executing itself by accident.

**Do:** split into read and write surfaces (same for `vanna_account`), scope them on the
token so a read-only caller is never *offered* a write tool, keep old names dispatching for
one release. Also retires the hand-maintained app-side remap that was missing
`vanna_auto_sign_status`.

**Gate on any public exposure of the MCP server.**

---

## P3 · Durable state — Cloud SQL <span>· app</span>

**Why this is correctness, not storage.** A four-leg plan two legs in, when the process
restarts, has no durable record of which two settled. The hand-rolled resume covers the case
where the *client* returns and tells us — it cannot cover a server restart, nor a plan
waiting hours for a human.

One Postgres schema, five concerns: sessions and history, approval records with expiry,
**execution checkpoints per leg**, standing orders, audit log. They reference each other, so
one schema beats five stores; Redis would serve approvals-with-TTL well and nothing else.

---

## M-C · MCP rate limiting, circuit breaker, per-tool timing <span>· MCP</span>

Rate limiting is described as *"the single most common production failure mode for AI agents
in 2026"*. Our loop fires up to eight parallel reads per turn across twelve turns — exactly
the shape that trips limits. The app's daily token cap meters the **LLM** bill and would not
stop a loop hammering `get_prices_batch`, nor protect us from a non-app client.

Token bucket per agent, cost-weighted (an account scan is not a price read). Circuit breaker
so a failing downstream degrades rather than cascades. Per-tool duration in the response —
settles whether a slow read is Soroban or the server.

Also **confirm resource-indicator audience validation** in `auth.py` — that a token was
issued for *this* server. Everything around it is right, so this is a check, not a build.

---

## P4 · Audit log <span>· app</span>

Every agent action against a verified identity: proposed, approved, executed, under which
mandate and cap, with the evidence IDs behind the numbers. Append-only.

Coinbase's agent wallet ships caps, limits, allowlists, multi-party approvals **and audit
logs** as one package; we have the first three. It is also the only way to investigate a
disputed transaction — today we would have a tx hash and no record of the approval, the cap,
or the figures the user was shown.

---

## P5 · Graded guardrail policy in code <span>· app</span>

One policy module every action routes through, grading by **reversibility, blast radius and
stakes**:

| Class | Control |
|---|---|
| Read | none |
| Simulate / what-if | none |
| Reversible write | approval; auto-sign within cap |
| Risk-increasing write | approval + floor check + revalidation at execution |
| Standing mandate | durable record + cap + expiry, else refuse |

We already behave this way, but the rule was never written down, so each new action
re-argues it — and the binding gate that blocked reads for four phases was exactly that
mistake. Same argument as `usable-read.ts`, which earned itself after the identical
failed-read defect appeared in three files.

---

## P6 · Execution-time revalidation <span>· app</span>

Approval expires on a five-minute clock, but the sizing depended on **prices**. Re-read
prices and re-run `sizing.ts` immediately before the first leg; re-propose if the floor no
longer holds. Small change; removes the worst realistic failure — a plan safe when shown and
unsafe when signed.

---

## P7 · Revisit the runtime, with evidence <span>· decision point</span>

Once P1 gives traces and P3 gives durable state, re-ask whether the hand-rolled loop should
move to LangGraph.js (TypeScript parity reported: StateGraph, conditional edges, durable
checkpointing, HITL breakpoints; works with Vertex Gemini; Next.js pattern is
`runtime = "nodejs"` with raised `maxDuration`).

**Do not pre-decide.** If checkpointing sits comfortably on our own loop, keep it. If we find
ourselves reimplementing graph semantics — conditional edges, interrupts, replay — we are
rebuilding LangGraph badly. **The trigger is standing orders reaching production.**

---

## Still open, needing a person not a phase

**The collateral definition.** Contract-settled: `get_current_total_balance_internal` walks
only `get_all_collateral_tokens()` — posted collateral. The app adds unposted SAC in the same
margin account. Ledger-pinned on `CBOQAN…G5XY`: app $1,087.20 / HF **3.90** vs contract
$953.80 / HF **3.42**.

Recommended: show posted, unposted, and compute health from posted — which also lets the
copilot say *"post your unposted balance and health goes 3.42 → 3.90"*. **Do not change the
app maths until the owner decides**; it is load-bearing for Margin and Portfolio.

---

## Reference

- Architecture and workflows, with all diagrams: `docs/copilot/diagrams/*.mmd`
  (import via Excalidraw → Mermaid to Excalidraw)
- Live prompt evidence: `docs/copilot/PROMPT-LIBRARY.md`
- Stress-test method: `.claude/skills/stress-test-copilot/SKILL.md`
