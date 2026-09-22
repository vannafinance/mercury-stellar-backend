# Handoff — Phase 2.5: make the failure visible, then fix it

**For:** the implementer (Grok 4.6). **Audited by:** Claude. **Revised:** 10 Sep 2026 (replaces the earlier draft + addendum).
**Branch:** `copilot-ui-rewire`.
**Baseline:** `tsc --noEmit` clean · `npx vitest run` = **1,491 passed / 1 failed / 2 skipped**. The one failure is the known network-flaky live-MCP `price of XLM` test.

Companion: the architecture blueprint — §2 current state, §6 domain model, §7 approval contract, §9 latency and cost, §11 phase order.

---

## 0. How to report back — do this every time

When you finish (or stop early), reply with a summary in exactly this shape. It is what
makes the audit fast and makes gaps visible instead of silent. **A summary that only lists
what worked is not useful** — the "not done" and "deviations" sections are the valuable ones.

```
## Summary

**Done**
- <file:line> — what changed, in one line
- ...

**Verified**
- <command run> → <actual result, not "passed">
- <live prompt tested> → <what the UI actually returned>

**Not done / deferred**
- <task> — why, and what it is blocked on

**Deviations from the handoff**
- <what I did differently> — why I judged it better

**New findings / questions**
- <anything discovered that the handoff did not anticipate>

**Suite:** tsc <clean|N errors> · vitest <passed>/<failed>/<skipped> (baseline 1491/1/2)
```

Rules for the summary:
- **Report failures as failures.** If a test fails or a prompt still errors, say so with the
  output. Do not describe partial work as complete.
- **Flag anything you changed that the handoff told you not to**, even if you think it was right.
- **If a hypothesis in this document turned out to be wrong, say which one and what the real
  cause was.** That is the single most useful line you can write.

---

## 1. Why this phase exists

Phase 2 landed a genuinely good read-tool registry — 24 audited capabilities, no writes
declared, identity bound from session scope, strict argument validation. All verified against
the code; it holds up.

But the prompt Phase 2 was built to enable **fails on the running app**:

```
can I withdraw 100 XLM without getting liquidated?
  → "I couldn't reach the information needed for this investigation. Please try again."
  → POST /api/copilot/investigate 200 in 10.8s
```

Why is unknown, because the error is swallowed. **Nothing after this phase is diagnosable
until the error is visible.** Do not start Phase 3 — which deletes ~6,000 lines of
decision-making code — while the new tool path fails silently.

Five tasks. Task 1 is two lines and unblocks Task 2.

---

## Task 1 — Stop swallowing the error

**File:** `app/api/copilot/investigate/route.ts:91-94`

The catch maps any non-`ResearchError` to a generic string and logs nothing. Log the cause
before sending the generic message; keep the user-facing string exactly as it is — this is
observability, not copy.

```ts
} catch (error) {
  const known = error instanceof ResearchError ? error : null;
  if (!known) {
    console.error("[copilot] investigation failed", {
      request_id, subject, network,
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
    });
  }
  send({ type: "error", code: known?.code ?? "research_unavailable", message: known?.message ?? "..." });
}
```

**Do not** put the raw error in the SSE payload — it can carry tool internals. Server log only.

**Then grep `lib/copilot/investigation/` for other `catch` blocks that discard the cause.**
A swallowed error inside the loop is the same defect one level down.

---

## Task 2 — Diagnose and fix the failing prompt

**Depends on Task 1.** Reproduce, read the log, fix the actual cause.

```
npm run dev          # then /copilot with wallet connected
can I withdraw 100 XLM without getting liquidated?
```

These are **ranked hypotheses, not a diagnosis.** Confirm against the real error first, and
tell me in your summary which one it was — or that it was none of them.

1. **Function-declaration rejection.** Phase 2 sends 24 read declarations plus
   `research_complete` / `clarify` / `blocked` with `toolConfig.mode: "ANY"`. If Vertex rejects
   the schema (unsupported type, over-long description, declaration-count limit) the whole call
   fails. Log the Vertex error body specifically.
2. **`can_withdraw` argument shape.** It takes a model-supplied `amount` through
   `decimalAmount()`, which throws on anything outside `^\d+(\.\d{1,18})?$`. If Flash emits
   `"100 XLM"` or `1.0e2`, that throws.
3. **MCP tool-name mismatch.** `vanna_can_withdraw` must exist server-side with the argument
   names `catalog.ts` binds (`smart_account`, `symbol`, `amount`). Verify against the live MCP
   server rather than assuming.

**Generalise whatever you find:** a single bad read argument should become **one failed
observation with a reason**, and the loop should continue. Any path where one read kills the
whole investigation is the same class of bug as the swallowed error, and fixing only the
instance leaves the class.

---

## Task 3 — A second submission that produces no request

**Observed:** two prompts submitted in one session, exactly **one**
`POST /api/copilot/investigate` in the server log, with the UI showing "Starting" and a Cancel
button while nothing was in flight.

Phase 1 fixed the *no-op* case (a new prompt now cancels the in-flight one). This is different:
the run enters a loading state and never issues the fetch.

Look, in order:

1. `hooks/use-investigation.ts` — between `setState({ loading: true })` and the `fetch`, the
   only awaited call is `requestHeaders(...)`. If it throws, aborts, or the `current()` guard
   returns early, loading is set with no request and possibly no error. **The early-return path
   is the prime suspect** — it returns without clearing `loading`.
2. `requestHeaders()` racing Privy. `auth.privy.io` was unreachable during testing. If the token
   fetch hangs to its 10s timeout then rejects, does the catch set an error state, or does an
   abort check swallow it first?
3. The `[wallet, cancel]` effect calls `cancel()` on wallet-identity change. If Privy re-resolves
   `address` mid-run, it can abort a run the user just started.

**Requirement:** every path that sets `loading: true` terminates in exactly one of `result`,
`error`, or explicit user cancel. Add a test that submits twice in sequence and asserts two
fetches.

---

## Task 4 — Fix the budget arithmetic

**File:** `lib/copilot/investigation/runtime.ts`

Phase 2 raised `maxToolCalls` 10 → 24 but left `maxDurationMs: 45_000` and
`maxReadDurationMs: 15_000`. With `MAX_BATCHED_READS = 8`, three batches of 15s reads consume
the whole window with nothing left for up to 12 Flash turns.

So the failure mode shifts from "ran out of reads" to "deadline" — the worse of the two, because
`service.ts:174` requires `outcome.kind === "research_complete"` for candidate generation. A
deadline yields `stopped`, so `candidates` is `null` and **the entire ranked strategy is lost**,
not merely shortened.

**Prefer (b):**

- **(a)** Raise `maxDurationMs` and re-derive the route promise. The ordering constraint in the
  file's own comment must hold: `runtime + scope (20s) + position (8s) ≤ route guarantee (75s)
  < client timeout`. Little headroom; mostly trades one ceiling for another.
- **(b) Degrade gracefully.** On deadline, if there are usable observations, finish as
  `research_complete` with what was gathered plus a warning naming what was not read, instead of
  `stopped`. Observations already survive a deadline (`runtime.ts:136` returns
  `outcome, observations`), so this only changes the label — and a timed-out investigation still
  produces a ranked, honestly-caveated strategy.

---

## Task 5 — Settle the collateral source of truth (measure only, change nothing)

**New, and it supersedes an earlier claim of mine that was too strong.** I previously wrote that
the contract is ground truth and the app is wrong. That was over-reach from a single spot-check.

The contract team has now clarified the actual liquidation path:

- **RiskEngine `liquidation_snapshot`** — *decides* liquidation.
- **AccountManager `liquidation`** — *performs* it.

**`liquidation_snapshot` is not referenced anywhere in this codebase.** Everything measured so
far (`get_current_total_balance`, `is_account_healthy`) is adjacent to the decision function, not
necessarily identical to it. So the earlier 2,858.90-vs-3,201.70 discrepancy may be comparing the
wrong pair.

**Do:** extend `scripts/audit-risk-engine.cjs` to read `liquidation_snapshot`, and record — for
one account, **pinned to a single ledger** — these side by side:

| Reading | Source |
|---|---|
| gross collateral, debt | `computeMarginSnapshot` (`lib/account-snapshot.ts`) |
| whatever basis it uses | RiskEngine `liquidation_snapshot` |
| recorded balances | AccountManager getters |
| total | RiskEngine `get_current_total_balance` |

**Do not change any sizing in this phase.** Output is a recorded measurement plus a
recommendation. Sizing changes are Phase 3, made once against whichever basis
`liquidation_snapshot` actually consults.

Simulation only — never sign. Note the ledger with every reading; the earlier comparison was not
ledger-pinned and price drift could explain part of a 12% gap.

**Still not in doubt** (measured directly, keep relying on it): the health boundary is strictly
greater than 1.10 — `is_account_healthy` returns false at exactly `1.100000`, true at `1.100001`,
matching the "Liquidation Threshold 1.10×" the Margin page displays. Borrowed proceeds are
credited into collateral, so a borrow raises both sides. Blend tracking receipts count, so a zero
recorded-collateral row is not an empty position.

---

## Optional if there is room — render `onProgress`

Nearly free, and it improves every phase between now and P4.5. The events are already emitted and
mostly not shown. Render what the investigation is doing — "Reading your position…", "Comparing
Blend vs Earn…" — instead of a bare spinner. Reduces no latency; it is the largest single gain in
*felt* speed, and it would make the Task 3 hang visible the moment it happens.

---

## What NOT to change

- **The trust boundary.** No write capabilities in the catalog; identity bound from `scope`;
  `validateModelArgs` keeps its exact key-set match. All three verified good.
- **`decimalAmount()`'s strictness.** If Task 2 is argument validation, fix the *error handling*,
  not the validator. A looser regex on a money field is the wrong trade.
- **Resume and multi-leg paths.** Correct and independently tested — `handle.ts:618` already
  carries `token_in`/`token_out` through a resume via `toSlots(l)`.
- **`router.ts` / `handle.ts` size.** That is Phase 3. Do not start it here.
- **Evidence IDs, the 60s staleness window, `sanitizeData`.** Untouched by Phase 2; keep it so.
- **Any sizing logic.** Task 5 measures; it does not change behaviour.

---

## Acceptance

1. `can I withdraw 100 XLM without getting liquidated?` returns a real answer on the running app,
   citing the `can_withdraw` read.
2. A deliberately broken read (bad argument, unknown tool) produces a specific server log line and
   a specific user-facing message — never a bare `research_unavailable`.
3. Two prompts submitted in sequence produce two `POST /api/copilot/investigate` entries.
4. A run that exhausts its time budget still returns ranked candidates with a warning, not an
   empty result.
5. Task 5 produces a recorded, ledger-pinned comparison and a recommendation.
6. `tsc --noEmit` clean; suite no worse than baseline (1,491 / 1 / 2).

---

## Decisions already settled — do not re-litigate

| Question | Decision |
|---|---|
| Durable state | **Cloud SQL (Postgres)** on `vanna-mcp`. Sessions, session logs, approvals, standing orders — one schema. Firestore is out; do not retry the IAM grant. |
| Inline leg editing | **Do not build it.** Conversational refinement in a persistent thread instead. Edit the inputs (floor, budget, assets, borrow yes/no), never output amounts. |
| Model | Move to **Gemini 3.8 Flash** — but only after P2.6 exists and the acceptance set is compared old vs new. Re-check published pricing when locking it. |
| Position freshness | Server-side cache keyed by `(smartAccount, ledger)`. **Never** a client-supplied number. |
| Bare `USDC` | Pre-resolve with a recommendation and one-click confirm, using actual holdings. Do not ask a bare question; do not ask at all when only one variant is held. |
| Exits | Only **deadline** is a defect. Blocked is a frequency problem. Clarify / out-of-domain / refused are correct behaviour — keep them. |

**MCP-side work — different repo, do not scope it here.** `C:\Users\akgam\Documents\vanna_mcp`,
GCP project `vanna-mcp`: spend/leverage/health caps including custom per-user limits under the
$1,000/day ceiling; tool parity with `catalog.ts`; per-tool latency.

---

## Next, in order

**P2.6 — the evaluation harness — comes before Phase 3, not after.** Phase 3 deletes ~6,000 lines
of decision-making code. The only honest way to know that deletion did not remove behaviour
someone relied on is a regression net built *before* the cut; built afterwards it can only encode
whatever survived. Every acceptance prompt in the blueprint, plus the historical failures in
`OPEN-ISSUES.md`, against recorded MCP fixtures in CI and live MCP on demand.
