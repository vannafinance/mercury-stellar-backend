# Handoff — Phase 2.7: the debt understatement, scope resolution, and the regression net

**For:** the implementer (Grok 4.6). **Audited by:** Claude. **Created:** 10 Sep 2026.
**Branch:** `copilot-ui-rewire`.
**Baseline (verified by me, not taken on trust):** `tsc --noEmit` **clean** · `npx vitest run` = **1,525 passed / 0 failed / 3 skipped**. Both match the Phase 2.5 report exactly; even the previously flaky live-MCP test passed.

Companion: the architecture blueprint — §6 domain model, §9 latency and cost, §11 phase order, §12 invariants.

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

**Suite:** tsc <clean|N errors> · vitest <passed>/<failed>/<skipped> (baseline 1525/0/3)
```

Report failures as failures, with output. Flag anything you changed that this document said
not to. **If a hypothesis here is wrong, say which and what the real cause was** — that was
the most useful part of the last report and it is what turned Task 1 into a real diagnosis.

---

## What Phase 2.5 actually achieved

Credit where due — the diagnosis was correct and the hypothesis-checking was exactly right:

- **Hypothesis 2 confirmed.** `decimalAmount()` / `resolveRead` threw outside any catch, escaped
  `runInvestigation`, and hit the route as the generic string. Now one failed observation.
- **Hypotheses 1 and 3 disproved** with evidence. 24 declarations are accepted; `can_withdraw`
  exists as `vanna_margin_trade` with the expected kwargs. Both worth knowing.
- **`liquidation_snapshot` located and probed**, and the 1.10 boundary independently
  re-confirmed (110/100 → false, 111/100 → true).
- Suite grew 1,491 → 1,525 with no regressions.

The deviations were all defensible and I would keep every one of them.

**But acceptance criterion 1 is still not met.** On the running app the flagship prompt now
returns:

> *"I couldn't read the wallet's margin-account association. Try again when account data is
> available."*

That is `ResearchError("account_unavailable")` from `scope.ts:47`, raised when
`vanna_resolve_account` comes back with `resolved.error`. This is genuine progress — the error
is now specific and honest instead of a generic shrug, which is exactly what Task 1 was for —
but the prompt still does not work. Task 2 below.

---

## Task 1 — The debt understatement (do this first; it is a safety bug)

**This is the most important thing in this document, and it is bigger than the last report
framed it.**

The Phase 2.5 measurement found the contract reporting debt of **~$2,705.60** against the app
snapshot's **~$1,684.99** on account `CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C`.
I checked the arithmetic in `docs/copilot/risk-engine-liquidation-snapshot.json` and it is exact:

| Reading | Value |
|---|---|
| `get_all_borrowed_tokens` | `["XLM", "USDC"]` — **two** debts |
| `get_borrowed_token_debt` (XLM) | 9,406.70 XLM ≈ **$1,683** |
| `get_borrowed_token_debt` (USDC) | 1,020.58 USDC ≈ **$1,021** |
| `get_current_total_borrows` | **$2,705.60** |
| App `totalBorrowedValue` | **$1,684.99** ← the XLM leg alone |

**The app is dropping an entire borrowed token.** And it fails in the dangerous direction:

```
App-computed HF:      4,230.94 / 1,684.99 = 2.51   ← "comfortably safe"
Contract-implied HF:  4,230.94 / 2,705.60 = 1.56   ← much nearer the 1.10 line
```

A user shown 2.51 will borrow far more than is actually safe. Every downstream sizing decision
inherits it.

**Where it happens:** `lib/account-snapshot.ts:178-189`, the borrowed-balance loop.

```ts
Object.entries(deduped).forEach(([token, { amount }]) => {
  const usd = parseFloat(amount) * tokenPrice(token);   // ← line 186
  totalBorrowedValue += usd;
});
```

Two candidate mechanisms, **both of the same class** — a real debt silently becoming zero:

1. **Price lookup miss.** `tokenPrice()` is `getCachedTokenPrice(token)` (line 30). The contract
   returns the bare symbol `"USDC"`, which `canonicalMarginToken` rewrites to `"BLUSDC"`
   (line 34). If the price cache has no `BLUSDC` entry at that moment, `usd = amount * 0 = 0`
   and ~$1,021 of debt vanishes with no error. **This is my leading hypothesis** — it produces
   exactly the observed XLM-only total.
2. **Dedupe-by-max drops a leg.** Lines 179-183 keep only the **largest `amount`** per canonical
   token rather than summing. Two variants canonicalizing to the same key (`"USDC"` and
   `"BLEND_USDC"` both → `BLUSDC`) means the smaller is discarded outright. It also compares
   `parseFloat(amount)` **across different tokens**, which is not a meaningful comparison in the
   first place.

**Confirm which before changing anything** — log both `deduped` and each `tokenPrice(token)` for
that account and look at the actual values.

**Then fix the class, not just the instance:**

- A **missing or zero price on a debt must be an error, never a zero.** This is the blueprint's
  "failed reads never become zeros" invariant, and it is currently violated on the debt side —
  the side where understating is dangerous. `computeMarginSnapshot` should refuse to return a
  total it knows is incomplete, the same way `snapshotIsUsable` already refuses a partial
  collateral read.
- **Sum debts per distinct token; never `Math.max` them.** If two symbols genuinely canonicalize
  to one asset, that needs a deliberate decision, not an accidental drop.
- Add a regression test from the fixture in `risk-engine-liquidation-snapshot.json`: an account
  with XLM **and** USDC debt must total both.

**Scope discipline:** fix the summation and the zero-substitution. Do **not** re-point sizing at
the contract in this phase — that is Phase 3, after Task 3 gives us a net.

**Also raise this with the app team.** The Margin page renders the same
`computeMarginSnapshot`, so users may be reading an overstated health factor right now. That is
theirs to triage, not a copilot fix.

---

## Task 2 — Scope resolution: an empty read is being reported as a fact

Acceptance 1 is still open, and further live testing has produced a **second**, different error
from the same function — intermittently, and after a long wait:

> *"This wallet isn't linked to your signed-in account. Link it in wallet settings before
> investigating its positions."*

That is `ResearchError("wallet_not_bound")` at `scope.ts:41`, on a wallet that demonstrably
**is** linked — the same session's account panel renders its health factor. Sometimes the same
prompt instead yields `account_unavailable` (`scope.ts:47`), and sometimes it runs out of time.

**The bug, at `scope.ts:29-41`:**

```ts
if (bound.error || bound.has_assertion !== true || bound.sub !== input.subject
    || !Array.isArray(bound.bindings)) {
  return { ...trader: null };            // malformed read → safe fallback to public scope
}
const unique = [...new Set(wallets)];
if (input.wallet && !unique.includes(input.wallet)) {
  throw new ResearchError("wallet_not_bound", "This wallet isn't linked…");   // ← line 41
}
```

An **empty** `bindings: []` satisfies `Array.isArray()`, so it skips the safe fallback. `unique`
is then `[]`, `[].includes(wallet)` is false, and the code asserts as fact that the wallet is not
linked. The function handles a *malformed* read cautiously and an *empty* read as proof of a
negative — which is backwards, since empty is the more suspicious of the two.

**The intermittency is the evidence.** A genuinely unlinked wallet fails fast and every time.
Slow-then-error, with the error varying between runs, is a read that did not come back properly
being reported as a fact about the user's account.

A second path reaches the same symptom: the row filter requires `row.active !== false` and
specific `revoked` / `revokedAt` / `revoked_at` spellings. If the binding row shape has drifted
server-side, every row is filtered out, `wallets` is empty, and the same false accusation fires.

**Fix:**

1. **Only claim "not linked" from positive evidence** — a non-empty bindings list that genuinely
   lacks this wallet. An empty list means *could not verify*: retry once, then fall back to
   public scope with an honest warning, never an accusation about the user's settings.
2. **Log what actually came back** (raw `bound`, the filtered `wallets`, and `input.wallet`).
   The Phase 2.5 logging work makes this cheap; use it here.
3. **Then determine whether `vanna_resolve_account` is erroring, returning empty, or timing out**
   inside `SCOPE_BUDGET_MS` (20s), and whether the trader address reaching it is the expected one.
   If it resolves elsewhere but not here, diff the arguments against the path the account panel
   uses.
4. **Cache scope per session for five minutes** (blueprint §9 lever 2). Two chained MCP calls run
   on every turn; caching removes the serial hop *and* shrinks the window in which this fails.
   Note that `SCOPE_BUDGET_MS` sits **outside** the loop, so the graceful-deadline work from
   Phase 2.5 does not cover a stall here — which is why some runs still die as "ran out of time".

**This needs the running app with a connected wallet, not a unit test.** The prompt has never yet
been observed to work end to end; a passing unit test is not a working feature.

---

## The pattern behind Tasks 1 and 2 — fix the class, not three instances

This is now the **third** occurrence of one defect: *a read that did not produce a usable answer
becomes a confident, specific, wrong statement.*

| Failed read | Became | Status |
|---|---|---|
| Partial collateral scan | "health factor 0.01" on a healthy account | Fixed by `snapshotIsUsable` |
| Missing `BLUSDC` price | $1,021 of debt → $0; HF 2.51 instead of 1.56 | Task 1 |
| Empty bindings list | "your wallet isn't linked to your account" | Task 2 |

The invariant is already written down — blueprint §12, *failed reads never become zeros* — and
enforced properly in exactly one place. That is the real defect: every read site reinvents the
discipline and some get it wrong, always in the direction of a confident falsehood.

**Introduce one shared helper** that read sites must route through: a result is either *usable*,
or *unavailable with a reason*. Never a silent zero, never an empty collection standing in for a
verified negative. Then convert these three call sites to it, and require new read paths to use
it. This is small, and it is what stops a fourth instance appearing in Phase 3.

---

## Task 3 — P2.6, the evaluation harness (this is the phase gate)

**Phase 3 does not start until this exists.** Phase 3 deletes roughly 6,000 lines of
decision-making code from `handle.ts` and demotes `router.ts`. A regression net built afterwards
can only encode whatever happened to survive the cut.

The opt-in Flash eval added last phase (`RUN_FLASH_INVESTIGATION_EVAL=1`) is the right seed —
generalise it:

- **Fixture-backed by default.** Recorded MCP responses so it runs in CI on every commit, with a
  `LIVE=1` mode for on-demand runs against real MCP.
- **Cover every acceptance prompt in the blueprint**, plus the historical failures in
  `OPEN-ISSUES.md`. At minimum: the withdraw prompt; the owner strategy prompt ("both USDC and
  XLM… health factor not below 1.3… may take new loans"); a bare-`USDC` prompt that must resolve
  or clarify rather than guess; a conditional that must be refused; an off-domain prompt.
- **Assert behaviour, not prose.** Which capability was requested, whether candidates were
  ranked, whether a non-borrowing alternative appeared, whether the exit was the right named one.
  Never assert on model wording.
- **Make it the gate.** A prompt that regresses fails CI loudly.

This is also what unblocks the Gemini 3.8 swap: run the set on 3.7, run it on 3.8, compare. A
smoke test is not an evaluation.

---

## What NOT to change

- **Sizing, anywhere.** Task 1 fixes a summation bug; it does not re-point the source of truth.
- **`decimalAmount()`'s strictness.** Last phase correctly fixed the error *handling* and left
  the validator strict. Keep it that way.
- **The trust boundary.** No writes in the catalog; identity bound from `scope`;
  `validateModelArgs` exact key-set match.
- **`router.ts` / `handle.ts` size.** Phase 3.
- **The Phase 2.5 deviations.** The outer catch in `runInvestigation`, `VertexError` for non-JSON
  bodies, and the audit script's `ECONNRESET` retry are all keepers.

---

## Acceptance

1. Debt totals every borrowed token; the fixture account sums XLM **and** USDC to ~$2,705.
2. A missing or zero price on a debt raises rather than silently contributing $0.
3. An empty bindings list never produces "this wallet isn't linked" — only a non-empty list that
   genuinely lacks the wallet does.
4. All three sites in the pattern table route through the one shared usable/unavailable helper.
5. `can I withdraw 100 XLM without getting liquidated?` returns a real answer **on the running
   app with a connected wallet** — a screenshot, not a unit test. Run it **five times**: the
   failure is intermittent, so one success does not close it.
6. Scope resolution is cached per session; a second prompt in the same session does not repeat
   the two chained MCP calls.
7. The eval harness runs fixture-backed in CI and fails loudly on a regressed prompt.
8. `tsc --noEmit` clean; suite no worse than 1,525 / 0 / 3.

---

## Still-open questions, carried forward

- **Ledger pinning.** The last measurement had `get_current_total_balance` at ledger 4600612 and
  `liquidation_snapshot` at 4600614. Adjacent, not identical. Once Task 1 lands, re-run pinned to
  one ledger — with debt summed correctly, the collateral figures may already agree and the whole
  discrepancy may reduce to this one bug.
- **Which basis `liquidation_snapshot` consults** for collateral, for Phase 3 sizing.

## Then, in order

**P2.6 gate met → Phase 3 (one planner).** `router.ts` becomes a read-through cache with no
authority to override a researched plan; `handle.ts` reduces to approval replay, execution,
settlement verification and receipts. That handoff comes separately, once this one is verified —
and the MCP-side blueprint is due for discussion at the same point.
