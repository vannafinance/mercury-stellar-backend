# Handoff — the floor is protocol law, not a question

**For:** the implementing agent (Gemini 3.8 Flash / Grok). **Author:** Claude, auditor.
**Created:** 13 Sep 2026. **Repo:** `vanna-copilot-orchestrator`, branch `copilot-upgrade` —
**this repo only.**

**Baseline I measured myself this turn:** `npx tsc --noEmit` exit **0** ·
`npx vitest run` → **1696 passed / 0 failed / 3 skipped**.

---

## 0 · The two rules

**Never hardcode.** A fix that names a capability, symbol, venue, phrase or **magic number** is
not a fix. Fix the mechanism, prove it on an input nobody enumerated. If the general fix is much
more work, say so and let Aditya decide — never quietly ship the enumerated one.

**Report actual values, never "verified".** Paste the real response body, counter, duration.
Every agent here — including the auditor — has had a confident claim fail checking. If a claim
in this document is wrong, say which and what the truth was.

Standing rules: copilot code only (report bugs in shared app libraries, do not fix them), no
commits or pushes without asking, `dev` is read-only.

---

## 1 · The decision Aditya made, and why it is right

The copilot currently **asks** for a health-factor floor before it will compile a leveraged
plan. That is wrong, and it is wrong for the same reason the old `1.30` default was wrong.

> **HF > 1.10 is protocol law.** It comes from the deployed RiskEngine, it is already imported
> as `LIQUIDATION_THRESHOLD` (`lib/margin-health.ts`), and it is **not a preference**. A user
> floor is a preference *on top of* that law.

So:

| Situation | Behaviour |
|---|---|
| **No floor stated** | **Proceed.** Validate against protocol law only. State the projected health factor next to the liquidation threshold on every plan. |
| **Projected HF ≤ 1.10** | **Refuse.** This is a breach, not a preference. Say so plainly. |
| **User states a floor** | Size to maintain it, then say what that permits: *"to keep your health factor at 1.4 you can deposit X and borrow Y — continue?"* |

Asking for a floor treats a fact the system already holds as if the user had to supply it. It
is the same defect as inventing `1.30`: one guesses, the other stalls, and neither uses the
number the protocol already gives.

---

## 2 · The distinction that makes this implementable

**Validating a plan and sizing a plan are different jobs, and only one of them needs a floor.**

- **Validation** — "does this plan breach the protocol?" Needs only `LIQUIDATION_THRESHOLD`.
  Applies to **every** plan, always.
- **Sizing** — "how much can I take?" Needs a target only when the user has not given the
  amounts. `put 10 xlm in and lever 3x into sousdc` states both the deposit and the multiple:
  **the plan is fully sized without any floor at all.** The floor question was never needed for
  that prompt.

That is why the current behaviour is wrong in the specific case that triggered it: the system
asked for a number it did not need in order to size a plan the user had already sized.

**The one case that genuinely needs a target** is an open-ended maximisation — *"borrow as much
as possible"*. With no stated floor the only defensible answer is the protocol threshold, which
is maximum risk. That is a legitimate **one closed question**, but it is a question about the
objective, not a blanket floor prompt:

> *"As much as possible against what safety margin? Liquidation is at 1.10."*

Use the existing `questionKind: "preference"` mechanism for that, and **only** for that.

---

## 3 · What to change

1. **Delete `DEFAULT_BORROW_FLOOR`** (`lib/copilot/investigation/proposal.ts:29`) and its use at
   `proposal.ts:66`. No invented number survives anywhere.
2. **`lib/copilot/investigation/capacity.ts:208`** currently returns `null` when no floor was
   stated, which sets `borrowingAllowed: false` and suppresses every borrow candidate. Change it
   so **absence of a user floor falls back to the protocol threshold** for validation, while a
   *stated* floor still drives sizing. The guard immediately below it —
   `if (floorWad < LIQUIDATION_THRESHOLD_WAD) return null` — stays exactly as it is: a stated
   floor at or below liquidation is still a breach.
   **Do not delete the six-decimal truncation above it.** `(1.3).toFixed(18)` is
   `1.300000000000000044`; at 18 places that noise made a stated floor of exactly 1.1 come out
   *above* the threshold and slip past this guard. The comment explains it — leave it visible.
3. **`lib/copilot/workflow/risk.ts:76`** — `if (steps.some(s => s.op === "borrow") && !proposal.floor)`
   returns *"A borrowing proposal needs an explicit health-factor floor."* Change the meaning:
   validate against `proposal.floor ?? LIQUIDATION_THRESHOLD`. Refuse on an actual projected
   breach, not on a missing preference.
4. **Answer copy** — `lib/copilot/investigation/answer.ts:130` and `:143` currently say
   *"Health factor after this would be 1.34."* Say the distance instead:
   *"Health factor moves 3.89 → 1.34; liquidation at 1.10."* The threshold must come from the
   imported constant, never a literal in a template string.

---

## 4 · The trap in this task — read before writing code

Aditya's words were *"if it comes to 1.10 it tell that it is 1.10 and u are at risk"*. The
obvious reading is a proximity warning — *warn when HF is near 1.10*.

**There is no derived value for "near".** Pick 1.2 and you have hardcoded a risk appetite, which
is the exact thing this pass exists to remove. Do not add a warning band, a caution zone, or a
"getting risky" threshold.

**Instead: always show the projected health factor beside the liquidation threshold.** The user
sees the distance on every single plan and judges it. Nothing is invented, and *"you are at
risk"* is communicated by the two numbers being close together, not by a constant deciding when
to speak.

If you believe a band is genuinely needed, **say so in your report and let Aditya decide** —
do not add one.

---

## 5 · Acceptance

1. `put 10 xlm in and lever 3x into sousdc` — **no question**, compiles both legs
   (`deposit_collateral 10 XLM` + the sized borrow), shows the projected HF against 1.10, and
   Approve is live. Trace it **live**, end to end, and paste the response body. Unit tests have
   passed on this path before while the live path was deposit-only.
2. A plan whose projection lands at or below 1.10 is **refused**, with the projected number in
   the message.
3. `keep my HF above 1.4 and deploy my idle USDC` — sizes to that floor and states what it
   permits before asking to continue.
4. `borrow as much as possible` — asks exactly one question, carrying
   `questionKind: "preference"`, and a reply in the thread continues the same investigation.
5. **`grep -rn "1\.3" lib/copilot --include=*.ts | grep -v test` returns no floor constant.**
6. Full suite: `npx vitest run` with no path. Report `tsc` exit and pass/fail/skip.

---

## 6 · Still open, unchanged

- **112 files uncommitted.** No restore point. Ask Aditya before committing; do not let it grow.
- `propose/route.ts` — non-abort failures still collapse to `proposal_unavailable`; confirm
  `cause` survives.
- **Langfuse §6** traces never dumped; **P3 Cloud SQL** not started.
- `/api/analytics/accounts` (35 s clean, up to 5 min degraded) and `computeMarginSnapshot` (12 s
  timeout) are **app-team libraries — report, do not fix.**
- MCP PR #3 adds `spendable` to the XLM wallet row. `candidates.ts` already prefers
  `row.spendable` with a fallback, so this side needs no change — but once the server is
  redeployed, **re-test "deposit all my idle XLM"**, which previously failed at simulation with
  `HostError #10`.
