# Handoff — P2: the planner cut, and runtime parity without a framework

**For:** the implementer (Grok 4.6). **Audited by:** Claude. **Created:** 10 Sep 2026.
**App:** `copilot-upgrade` @ `8385fab` · **MCP:** `main` @ `60b2717` (merged, deployed).
**Baseline:** `tsc` clean · vitest **1,600 / 0 / 3** · pytest **559**.

**Deployed and current — do not redeploy:** `vanna-mcp-server` `00090-v5g`,
`vanna-sign-service` `00048-vck`, `vanna-connect-gateway` `00011-mwr`. All from clean
`main`. Use `.claude/skills/deploy-mcp-services` and **verify before deploying**.

---

## 0. Report back

`**Done** / **Verified** / **Not done** / **Deviations** / **New findings**`, naming the
repo per change, plus `**Suite:** tsc · vitest · pytest`. Log every live prompt to
`docs/copilot/PROMPT-LIBRARY.md`.

---

## P1 verified, and it found something

Telemetry landed clean: spans for `invoke_agent`, `investigation.{scope,position,loop,turn}`,
`generate_content`, `tools/call`; token usage and thinking level on Vertex spans; no prompts,
payloads, XDR or secrets on spans. Suite 1,585 → **1,600**. Both deviations were right —
`BatchSpanProcessor` keeps export off the investigation clock, and NodeSDK always starting
means AsyncLocalStorage context exists even when nothing is exported.

The finding worth keeping: **`@opentelemetry/api`'s default context manager is a no-op**, so
without AsyncLocalStorage the token usage never lands on the model span. That is the kind of
thing that would have produced silently empty metrics for weeks.

**Nothing exports yet** — see §4.

---

## Task 1 — Finish the planner cut  <span>· the phase</span>

| File | Now | Target |
|---|---|---|
| `handle.ts` | **8,642** | ~2,000 |
| `router.ts` | **2,643** | read-through cache |

Unchanged since Phase 3 started. `shouldUseLegacyExecutor` is gone and the read-cache
exists, but **no decision path has been removed**.

- **Keyword write planning for the assistant widget** is the largest remaining one. Peel it
  first.
- `router.ts` answers exact-match reads early and otherwise steps aside. It must not be able
  to override a researched plan.
- `handle.ts` keeps approval replay, write execution, settlement verification, receipts.

**One decision path at a time, eval gate between moves.** P1 now gives traces — capture a
trace before and after each move and compare. That is what telemetry-first was for.

**Keep untouched:** resume and multi-leg execution, the trust boundary, `usable-read.ts`,
the binding rules, the drift guard.

---

## Task 2 — Runtime parity: what we must have, framework or not  <span>· new</span>

We are not adopting LangGraph. That decision stands, and it is only defensible if our own
loop does not *lack* what a framework would have given us. This is that checklist — treat
each row as a requirement on our runtime, not as an argument for migrating.

| Capability | LangGraph gives | We have | Gap |
|---|---|---|---|
| Typed state | `StateGraph` schema | Typed `InvestigationState`, validated args | — |
| Conditional routing | Conditional edges | One branch: continue or terminate | — |
| Streaming | Built-in | SSE with progress events | — |
| Per-step timeout | Node config | Per-read 15s, loop 45s | — |
| **Durable checkpointing** | `PostgresSaver` | **in-memory only** | **P3** |
| **Interrupt / resume** | `interrupt()` breakpoints | Approval exists but is not durable | **P3** |
| **Replay a past run** | Checkpoint replay | Traces from P1 — read-only, not re-executable | **partial, acceptable** |
| **Per-step retry policy** | Node retry config | Ad-hoc; per-read deadline only | **Task 2b** |
| Observability | Callbacks | OTel spans (P1) | — |

**Two real gaps, and neither needs a framework:**

**2a — Checkpointing and durable interrupts** are P3 (Cloud SQL). Naming them here so the
parity argument is explicit rather than assumed.

**2b — A declared retry policy per step.** Today retry behaviour is scattered: reads get a
deadline, the audit script retries `ECONNRESET`, scope resolution retries once. Make it one
policy object per operation class — how many attempts, what backoff, which errors are
retryable, and what happens on exhaustion. A framework would force this structure; without
one we have to impose it.

**Replay is the accepted gap.** LangGraph can re-execute from a checkpoint; our traces let
us *see* a past run but not re-run it. That is fine — for a system that moves money,
re-executing a past run is a footgun, not a feature. Say so rather than treating it as a
deficiency.

---

## Task 3 — The signed-in battery  <span>· still not run</span>

Every copilot result so far is **guest**, which tests a path no user takes. `scope.ts`
drops the G-address when `subject === guest`, so those results are artifacts.

Run in the logged-in `/copilot` tab:

1. **The owner paragraph, verbatim** — *"use some USDC and BLUSDC to build a strategy so my
   health factor doesn't go below 1.3 — you can use spot and farm markets yourself, and you
   can even take new loans."* Five times auto-approve **ON**, five **OFF**.
2. **Messy prompts** — "am I going to get liquidated?", "is my money safe", "wats my helth
   factor", "do something with my idle funds", a health question in Hindi, and
   *"borrow as much as possible but stay completely safe"* (naming the tension is a pass;
   silently picking a side is `WRONG`).
3. **Three-turn refinement** in one thread — owner paragraph → "make it 1.4 instead" →
   "actually use XLM too".
4. **A landed 1 XLM repay** from the session owner, with a hash and Horizon
   `successful: true`. **Until a transaction lands, the write path is unproven** regardless
   of how many simulations pass.

Blocked on the embedded-wallet constraint below — resolve that first.

---

## Task 4 — Two environment issues blocking the above

**4a — Auto-approve needs a Vanna embedded wallet.** The new copy is correct and is the
answer to the `session_user_mismatch` puzzle: *"Session signing (and HF guardian) needs a
Vanna embedded wallet — Freighter signs in its own popup, which this app cannot skip."*

So the auto-sign battery cannot run on a Freighter wallet at all. Either the test account
gets an embedded wallet, or **auto-approve ON is untestable and should be recorded as
blocked** rather than left looking unrun. Say which.

**4b — Telemetry exports nothing.** `.env.local` still contains the literal template:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://<langfuse-host>/api/public/otel
```

`<langfuse-host>` was never substituted, so there is no Langfuse instance and no traces.
Stand one up (see §4 of the summary), then confirm a real trace arrives before claiming P1
acceptance. **P1's acceptance — a truthful breakdown of a slow turn with the dominant cost
named — is still outstanding.**

---

## Acceptance

1. `handle.ts` materially smaller; `router.ts` cannot override a researched plan; eval green.
2. A per-step retry policy exists as one declared object, not scattered behaviour.
3. Traces arrive in Langfuse, and a slow turn's dominant cost is named from them.
4. The owner paragraph answers on the signed-in UI — 5× ON (or recorded blocked) and 5× OFF.
5. One repay lands with a Horizon hash.
6. `tsc` clean; vitest ≥ 1,600/0/3.
