# Handoff — Phase 3: one planner, and a source of truth that is proven rather than assumed

**For:** the implementer (Grok 4.6). **Audited by:** Claude. **Created:** 10 Sep 2026.
**Branch:** `copilot-upgrade`.
**Baseline (verified, not taken on trust):** `tsc --noEmit` **clean** · `npx vitest run` = **1,570 passed / 0 failed / 3 skipped**.
**Sizes to beat:** `handle.ts` **8,642** lines · `router.ts` **2,615** lines · `fast-path.ts` 185 lines.

**Both repos are in scope** — app at `vanna-copilot-orchestrator`, MCP at
`C:\Users\akgam\Documents\vanna_mcp` (GCP project `vanna-mcp`). Name the repo per change.

---

## 0. How to report back — same format, every time

```
## Summary

**Done**
- <repo> <file:line> — what changed, in one line

**Verified**
- <command run> → <actual result, not "passed">
- <live prompt tested> → <what the UI actually returned>

**Not done / deferred**
- <task> — why, and what it is blocked on

**Deviations from the handoff**
- <what I did differently> — why I judged it better

**New findings / questions**
- <anything the handoff did not anticipate>

**Suite:** tsc <clean|N errors> · vitest <passed>/<failed>/<skipped> (baseline 1570/0/3)
```

---

## What Phase 2.9 achieved

The diagnosis was the valuable part: **the 57s turn was the loop re-reading through MCP what
the seeded app snapshot already held.** Fixing that removes whole round trips rather than
shaving them.

- Health / debt / collateral now served from the seed, tagged
  `source: "vanna_app_margin_snapshot"`, with `finishRead()` distinguishing `snapshot` from
  `mcp`. Provenance is explicit, not fabricated — the right way to do this.
- Per-read deadlines, so one stalled call no longer holds the whole batch until the run dies.
- `unwrapToolData` in `mcp-client.ts` — central, depth-capped, handles `content[].text` JSON.
  Once in the client rather than twelve times in the normalizer, as specified.
- USD renders at exactly 2 decimals; token amounts keep 7.
- Phase logging (`logPhase`) so the turn can finally be attributed.

Suite 1,559 → **1,570**. `tsc` clean.

**Still unverified live:** the latency win, `can_withdraw` producing a fact, and the five
signed-in runs. Those carry into this phase's acceptance.

---

## Do this in two passes — report back between them

Tasks 1 and 2 are independent and both large. Doing them in one pass produces a diff big
enough that a failure tells you nothing about which half caused it.

- **Pass A — Tasks 1, 3, and as much of 4 as is automatable.** Source of truth, the
  timestamp fix, and the phase-latency capture. Report back. This establishes a verified
  baseline, and gets sizing onto the right basis *before* anything is deleted.
- **Pass B — Task 2.** The planner consolidation, against that verified baseline.

Do not begin Pass B until Pass A is reported and the suite is green. The eval gate is what
makes the deletion safe; running it against a baseline that is itself in flux wastes it.

---

## Task 1 — Source of truth: display from the snapshot, size from the contract

**The question Phase 2.9 raised without answering: should the copilot depend on the *app*
snapshot at all, or on the *contract*?**

Both, for different jobs. Today both display and sizing use the app snapshot
(`computeBorrowCapacity` takes it as `shared`), which is at least self-consistent — but
sizing against an unverified source is the one place that can cost a user money.

| Use | Source | Why |
|---|---|---|
| **Display** — "your health factor is 3.90" | App snapshot | Must match the Margin page. A copilot that disagrees with the page is worse than one that is a few seconds stale. |
| **Sizing** — "you can borrow $X before breaching 1.30" | **Contract** | This is what actually decides liquidation. Consistency with a wrong figure does not prevent one. |

We already hit this once: an intermittently dropped USDC debt leg showed HF **2.51** where
the contract implied **~1.56**. It is fixed, but nothing currently *detects* the next drift.

**Do:**

1. **(MCP) Expose `liquidation_snapshot` as an audited read.** It is the function the
   contract team confirmed *decides* liquidation (AccountManager's `liquidation` performs
   it), and it appears nowhere in either repo today. Read-only, no writes, identity bound
   from scope like every other capability in `catalog.ts`.
2. **(App) Reconcile, ledger-pinned.** For one account at one ledger, compare
   `computeMarginSnapshot` against `liquidation_snapshot`. This is the measurement Phase 2.5
   asked for and never got pinned — the earlier 2,858.90 vs 3,201.70 gap was never proven to
   be a real disagreement rather than price drift between two unpinned reads.
3. **(App) Make drift loud.** Beyond a small tolerance, the copilot refuses to quote a sized
   figure and says the two sources disagree. Never silently prefer one. This is the same
   invariant as `usable-read.ts`: no confident answer from an unreliable input.
4. **(App) Size against the contract basis** once step 2 establishes what that basis is.
   Display can keep using the snapshot.

**Do not** synthesise a health factor MCP-side — settled in 2.8, still settled.

---

## Task 2 — One planner

This is the phase the whole plan has been building toward, and the eval gate from 2.6/2.7
now exists, so there is a regression net before the cut.

- **`router.ts` (2,615 lines) becomes a read-through cache.** Exact-match reads only —
  price, health — answering in under a second and returning early. **No authority to
  override a researched plan.** `fast-path.ts` (185 lines) is already the right shape;
  extend that, retire the rest.
- **`handle.ts` (8,642 lines) reduces to approval replay, write execution, settlement
  verification and receipts.** Target roughly 2,000 lines. Everything that *decides* moves
  to the investigation loop.
- **`shouldUseLegacyExecutor` already returns a hard `false`**, and only
  `copilot-workspace.tsx` still references it (twice). Remove the references and the
  function together — a dead gate that looks live is a trap for the next reader.

**Sequence it so the tree is green at every step.** Move one decision path at a time and run
the eval suite between moves; a single 6,000-line deletion that fails the gate tells you
nothing about which move broke it.

**Keep untouched:** resume and multi-leg execution (correct and independently tested —
`handle.ts:618` carries `token_in`/`token_out` through a resume via `toSlots`), the trust
boundary, `usable-read.ts` semantics, and the binding rules in blueprint §7.

---

## Task 3 — Snapshot-backed observations claim to be fresher than they are

`runtime.ts:337` stamps every observation `observedAt: now()`, including snapshot-backed
ones. The comment is honest — *"upstream data can be older still"* — but the consequence is
that the 60s `maxEvidenceAgeMs` check treats seeded data as brand new when it can be a full
turn old.

Small fix, real correctness: **inherit the seed observation's `observedAt`** so age is
truthful, and let the staleness check do its job. Cheap now; harder to reason about once
sizing depends on it.

---

## Task 4 — Carried-forward live verification

None of these can be settled from a terminal; they need the signed-in browser.

1. **Latency.** With `logPhase` in place, capture the breakdown for a strategy turn and name
   the dominant cost. Target: strategy under 15s, account question under 5s. If the levers
   available cannot get there, say what is actually eating the time.
2. **`can_withdraw` produces a fact** — the answer states whether the withdrawal is allowed,
   with no "no supported display fields" warning.
3. **Five runs of the flagship prompt on the signed-in UI, with auto-approve ON and again
   with it OFF.** Both states take different code paths and each has its own failure
   history: OFF once discarded a built XDR instead of staging it; ON once executed
   single-leg writes with no preview. A pass in one is not a pass in the other.

---

## Acceptance

1. `liquidation_snapshot` is available as an audited MCP read.
2. A ledger-pinned comparison of `computeMarginSnapshot` vs `liquidation_snapshot` is
   recorded, with a recommendation for the sizing basis.
3. A drift beyond tolerance blocks a sized answer instead of quoting one.
4. `router.ts` has no authority to override a researched plan; `handle.ts` is materially
   smaller (target ~2,000 lines) and the eval suite still passes.
5. `shouldUseLegacyExecutor` and its references are gone.
6. Snapshot-backed observations carry the seed's timestamp.
7. The flagship prompt answers on the signed-in UI — five runs, both auto-sign states.
8. `tsc --noEmit` clean; suite no worse than 1,570 / 0 / 3.

---

## Then — the MCP blueprint

Due for discussion once this lands, and deliberately deferred until now: the copilot's
required tool surface stops moving when Phase 3 fixes it. It should cover tool parity with
`catalog.ts`, where caps live (incl. custom per-user limits under the $1,000/day auto-sign
ceiling), per-tool latency, and whether to expose the MCP server publicly as Aave did on
8 Sep 2026 — a strategic fork deferred, not declined.
