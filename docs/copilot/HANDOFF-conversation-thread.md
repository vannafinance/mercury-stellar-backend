# Handoff — the conversation thread, and why it is now the critical path

**For:** the implementer. **Author:** Claude, auditor. **Created:** 11 Sep 2026.
**App:** `copilot-upgrade` @ `a69e56b`. **Baseline:** `tsc` clean · vitest **1,644 / 0 / 3**.

---

## The milestone, first

**A transaction landed.** `repay 1 XLM` — tx `075aa4a1…`, ledger **4619359**, Horizon
`successful: true`, source `GD4BQR…NPDH`. Proposed → approved → signed → submitted → settled
→ independently confirmed.

"No transaction has ever landed" was the headline gap in every handoff since this began. It
is closed. **The write path works.**

Worth noting what fixed it: not the write code. Bounding the app snapshot so the risk
validator could finish. Five failures, one root cause.

---

## What the acceptance battery found

Six prompts were queued. **Three could not be run at all**, and the reason is the same one.

### The blocker — the UI is single-shot

The acceptance prompt produced **correct behaviour**:

> *"One choice still changes the plan: how much BLUSDC (193 available) and which USDC variant
> and amount (AQUSDC 2,680 / SOUSDC 74,985) would you like to commit?"*

That is exactly right. The architecture prefers **clarify over guess**, and guessing which
USDC is the single worst thing this copilot can do.

**There is no way to answer it.** The only input is the top prompt bar, which starts a *fresh*
investigation and discards the question. The thread does not persist.

So the better behaviour produces a dead end. **Every open-ended strategy prompt dies at the
first question** — which is most of them, because open-ended prompts are the ones that need
clarifying.

It also blocks the refinement model in blueprint §7 — *build the thread, not the edit field*.
Conversational refinement (`"make it 1.4 instead"`) was chosen **instead of** inline leg
editing, and inline editing was rejected for good reasons. With no thread, neither exists.

**Blocked, not failed:** owner acceptance paragraph · three-turn refinement · bare-`USDC`
ambiguity. Do not log these as failures.

### Also found

| Prompt | Result | Note |
|---|---|---|
| `supply my USDC to the best pool` | **45s, timed out** | Message is also broken — *"Recorded wallet balances before the time budget ran out. Recorded account health before the time budget ran out…"* repeated seven times. A degraded answer should say what it **has**, not list what it missed. |
| `borrow as much as possible but stay completely safe` | **1m 39s, timed out** | Never reached the contradiction. Cannot tell whether it would name the tension. |
| Snapshot timeout | Still surfacing | `SnapshotTimeoutError` at 12s appears as a dev overlay. Working as designed, but the caller should degrade quietly rather than log at error level. |

**Strategy prompts are timing out at 45s–1m39s.** Reads and health are fast now; the full
loop is not.

---

## Task 1 — Build the conversation thread  *(the critical path)*

Not a UI nicety. It is the thing standing between a copilot that asks good questions and one
that can be used.

**Required behaviour:**

1. **The thread persists on screen.** Prompt, answer, clarifying question, reply, revised
   answer — stacked, in order, visible.
2. **A reply continues the same investigation.** Typing an answer must resume with the
   existing `continuation`, not start a new run. The question already carries the context;
   the reply must reach it.
3. **A reply is an answer, not a new prompt.** When a question is open, the input is scoped
   to it. `"SOUSDC"` means *that variant*, not a fresh investigation about SOUSDC.
4. **Refinement works the same way.** `"make it 1.4 instead"` after a proposal re-solves with
   the new floor. Full re-solve, correctly fingerprinted — never a partial edit.
5. **Sessions survive reload.** A thread is a session. Server-side, keyed by verified subject.

**Do not build an editable amount field.** Blueprint §7 — it hands the user a control that
breaks the constraint the system exists to protect, then makes them guess numbers against a
solver. **Edit the inputs, never the outputs.**

**Note the ordering consequence:** this needs session persistence, which is **P3** (Cloud
SQL). A bounded in-memory thread is acceptable for the first pass so the battery can run —
but say plainly that it is in-memory and dies on restart.

---

## Task 2 — Strategy prompts must finish

45s and 1m39s, both timing out. The loop budget is 45s and the route promises 75s, so these
are hitting the ceiling rather than failing.

Use the Langfuse traces — that is what P1 was for. Name the dominant span with a number
before changing anything. Known suspects, in order: scope resolve measured at **13.1s** on a
cold cache, Vertex turns at **~26s** each, and pre-seeded reads that are not yet pre-seeded.

**Also fix the degraded message.** Repeating *"Recorded X before the time budget ran out"*
seven times tells the user nothing. A partial answer should lead with **what it established**
and name what is missing once.

---

## Task 3 — Quieten the snapshot timeout

`SnapshotTimeoutError` at 12s is correct behaviour and should not log at error level. Callers
that already handle it should degrade quietly; the dev overlay is noise that masks real
issues.

---

## Order, and who

1. **Task 1 — the conversation thread.** Everything the battery needs is behind it. **This is
   the whole next pass.**
2. **Task 2 — strategy latency.** Traces first, optimise second.
3. **Task 3** — small.

P2's remaining planner peel, P3, P4, P5 all continue after. **None of them unblock the
battery; the thread does.**

Rules unchanged: copilot scope only, no commits, no pushes, no PR from `copilot-upgrade`,
`dev` is read-only. Report once at the end in the standard format.
