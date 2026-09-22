# Handoff — Phase 2.9: the investigation runs out of time before it can answer

**For:** the implementer (Grok 4.6). **Audited by:** Claude. **Created:** 10 Sep 2026.
**Branch:** `copilot-upgrade`.
**Baseline (verified, not taken on trust):** `tsc --noEmit` **clean** · `npx vitest run` = **1,559 passed / 0 failed / 3 skipped**.

Companion: the architecture blueprint — §9 latency and cost, §12 invariants.

---

## 0. How to report back — same format, every time

```
## Summary

**Done**
- <file:line> — what changed, in one line

**Verified**
- <command run> → <actual result, not "passed">
- <live prompt tested> → <what the UI actually returned>

**Not done / deferred**
- <task> — why, and what it is blocked on

**Deviations from the handoff**
- <what I did differently> — why I judged it better

**New findings / questions**
- <anything the handoff did not anticipate>

**Suite:** tsc <clean|N errors> · vitest <passed>/<failed>/<skipped> (baseline 1559/0/3)
```

**Both repos are in scope** — app at `vanna-copilot-orchestrator`, MCP at
`C:\Users\akgam\Documents\vanna_mcp` (deploys to GCP project `vanna-mcp`). Name the repo
for every change.

---

## What Phase 2.8 achieved

The timer work paid off immediately, and the judgement calls were right:

- **Honest timing at last.** The card now reads *"Checked in 57s · 57s this device"* — a
  real per-run duration that freezes on completion. Every latency number before this was
  measured against a clock that started at mount.
- **`vanna_auto_sign_status` was missing from `LEGACY_TOOL_MAP`** — a genuine parity miss
  that would 404 on a composites-only MCP. Good catch; exactly the class Task 5 was for.
- **Declining to rename `can_withdraw` to `vanna_margin_trade` was correct.** Keeping a
  read-only catalogue name so the model cannot aim at a write dispatcher is a better
  answer than the alignment I asked for. Keep it.
- **Declining to add an MCP `health_factor` was correct**, per the stated preference.
- HF now renders `3.90`; suite 1,547 → 1,559.

**And the handoff's central hypothesis was half wrong, as you found:** today's live health
payload *does* carry `collateral_usd` / `debt_usd` / `ltv_ratio`, so the old normalizer
would have extracted facts from it. `is_healthy` was the real gap. Worth stating plainly
because it redirects this phase.

---

## The live run that defines this phase

Post-fix, auto-approve **ON**, bound wallet:

```
can I withdraw 100 XLM without getting liquidated?

  Partial research: the time budget ran out before account health, account collateral, account debt
  Your reported margin debt is $278.9886.
  Checked in 57s · 57s this device

  ! can withdraw:       no supported display fields were available.
  ! account health:     data was unavailable. No value was assumed.
  ! account collateral: data was unavailable. No value was assumed.
  ! account debt:       data was unavailable. No value was assumed.
  ! The investigation ran out of time. Ranked options use only the reads that finished.
```

**The reads are not failing on shape any more. They are not finishing.** Three of the four
never completed inside the budget, and the banner says so explicitly. That reframes
everything: field mapping was a real bug and is now largely fixed, but the prompt still
cannot answer because the investigation runs out of time.

---

## Task 1 — Latency, and this time it is measured

**You were right to defer this in 2.8** — "do not invent a latency problem" was the correct
call with a lying clock. The clock is now honest and the problem is demonstrated: **57s
wall, against a 45s loop budget, with three reads unfinished.** Task 4 is now justified.

Start by finding where the 57s actually goes, then cut. Do not optimise blind.

1. **Instrument the phases.** Log elapsed ms for scope resolution, the position read, and
   each model turn plus each read batch. The `elapsedMs` you added covers the whole turn;
   this needs the split. One line per phase is enough.
2. **Establish why individual reads are slow.** `maxReadDurationMs` is 15s. Three reads
   unfinished within a 45s window suggests reads are running near that cap. Is it Soroban
   RPC, MCP cold path, or serialisation behind a single connection? The keys-only logging
   from 2.8 plus a per-read duration will say.
3. **Then apply the cheap levers** from blueprint §9 that are not yet in:
   - **Pre-seed the reads always needed** — fire prices concurrently with the first model
     call instead of waiting for the model to request them.
   - **Server-side position cache** keyed by `(smartAccount, ledger)`, warmed by page load.
     Never a client-supplied number.
   - (The 5-minute scope cache already landed in 2.7 — confirm it is actually hitting.)
4. **Re-measure and report both numbers.** Before and after, from the honest clock.

**Target:** a strategy turn under 15s, an account question under 5s (blueprint §9). If
after instrumentation the time is dominated by something none of these levers touch, say
so and stop — that finding is worth more than a speculative optimisation.

---

## Task 2 — USD amounts render to 4 decimal places

`answer.ts:9`:

```ts
const value = Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 7 }) : fact.value;
return fact.unit === "USD" ? `$${value}` : `${value} ${fact.unit}`.trim();
```

One `maximumFractionDigits: 7` serves both branches, so a USD fact renders `$278.9886`.
The 7 is right for token amounts (Stellar's precision) and wrong for money.

Split it: **USD → 2 decimals**, token units → up to 7. Same rule as the HF fix — round for
display only, keep full precision in the stored fact. Check the other formatters on this
surface for the same leak.

---

## Task 3 — `can_withdraw` still yields zero facts, and the mapping is correct

I verified the new mapping: it bypasses `decimal()` and pushes
`value: allowed ? "allowed" : "not allowed"` directly, so a boolean is handled. And the
screenshot above is **post-fix** — it carries the new per-run clock. So the fact really is
still empty.

Your own envelope hypothesis is the strongest lead, and it is now cheap to settle:

- `mcp-client.ts:581` already unwraps `payload?.result`. Check whether `can_withdraw`
  arrives double-wrapped, under a different key, or through a path that skips that unwrap.
- The keys-only logging you added in 2.8 answers this on the next live run — read it before
  changing anything.
- If the envelope differs by tool, unwrap centrally in the client rather than per capability
  in the normalizer. A shape quirk handled in twelve `case` branches is twelve places to
  drift.

Note the asymmetry worth explaining in your summary: `can_withdraw` returned **"no supported
display fields"** (succeeded, zero facts) while the other three returned **"data was
unavailable"** (never finished). Those are different problems in one screenshot.

---

## Task 4 — Test with auto-approve OFF as well

Every live result so far is from **auto-approve ON**. The two states take different code
paths and a pass in one is not a pass in the other:

- **OFF:** every write waits for an explicit Approve & sign; no binding required, because
  the wallet signature is the proof.
- **ON:** writes clearing Sign Service policy execute with no prompt, within the $1,000/day
  cap; requires a binding.

Both states have their own history of failure — auto-sign OFF once discarded a built XDR
instead of staging it; auto-sign ON once executed single-leg writes with no preview. Run
the acceptance prompts in **both**.

---

## What NOT to change

- **The `can_withdraw` catalogue name.** Your read-only name that cannot aim at the write
  dispatcher is better than the alignment I originally asked for. Keep it.
- **No MCP `health_factor`.** Settled — the app maps `is_healthy` /
  `distance_to_liquidation` instead.
- **Sizing and the source of truth.** Phase 3, pending the ledger-pinned
  `liquidation_snapshot` measurement.
- **`lib/usable-read.ts` semantics.** A failed read stays unavailable-with-reason.
- **`router.ts` / `handle.ts` size.** Phase 3.

---

## Acceptance

1. A phase-by-phase latency breakdown is logged, and the dominant cost is named.
2. A strategy turn completes inside its budget with **no** "ran out of time" banner, or the
   phase reports why that is not achievable with the levers available.
3. `can_withdraw` produces a fact on a live run — the answer states whether the withdrawal
   is allowed.
4. USD renders as `$278.99`, token amounts keep their precision.
5. `can I withdraw 100 XLM without getting liquidated?` answers on the signed-in UI —
   **five runs, with auto-approve ON and again with it OFF.**
6. `tsc --noEmit` clean; suite no worse than 1,559 / 0 / 3.

---

## Then

**Phase 3 — one planner.** `router.ts` becomes a read-through cache with no authority to
override a researched plan; `handle.ts` reduces to approval replay, execution, settlement
verification and receipts. The eval gate exists, so the regression net is in place before
the cut. The MCP-side blueprint is due for discussion at the same point — including
exposing `liquidation_snapshot` as an audited read, which Phase 3 sizing needs.
