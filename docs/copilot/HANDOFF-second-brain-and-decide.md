# Handoff — retire the second brain, then make it decide

**For:** Grok (Hermes). **Author:** Claude, auditor. **Created:** 13 Sep 2026.
**Repo:** `vanna-copilot-orchestrator`, branch `copilot-upgrade` — **this repo only.**
**Baseline I measured myself:** `tsc` clean · vitest **1687 / 0 / 3** (up from 1653).

---

## 0 · Audited, and mostly confirmed

I checked the diff rather than the report. These are **verified good** — the mechanism was
fixed, not the instance:

- **`candidate-id.ts`** is a real single owner. Producers mint through `candidateId()`, the
  propose route imports `isCandidateId` (route line 35) instead of copying the regex, and the
  minter **throws** on an invalid id rather than emitting one. Correct.
- **`normalize.ts` is shape-driven.** The 14-case capability switch is **gone — zero cases
  remain**. Units now come from `_usd` / `_pct` / `_wad` / `_human` / `_address` suffixes.
- **You wrote the acceptance test I specified**, not a proxy for it:
  *"extracts a capability that has never had a branch from suffix shape."* That is the test
  that proves a mechanism fix. Good.
- **`research-config.ts`** derives the network from `NETWORK_PASSPHRASE` and deletes
  `COPILOT_RESEARCH_NETWORK` entirely — confirmed gone from all code. You also gave the
  disabled case its own code (`research_disabled`), which is better than I specified.
- **1687 tests pass, tsc clean.** Verified on my machine, not taken from your report.

So: credit where due. Two claims in your report do not survive checking, and both matter.

---

## 1 · There is a second brain, and it is still wired in  *(the finding that answers Aditya's question)*

Your report says *"no regex stated-write parser"* and *"no few-shot utterances, no phrase
lists."* For `lib/copilot/investigation/**` that is **true** — I checked, `requested-actions.ts`
is clean.

But `lib/copilot/router.ts` is still there, and it is still live:

| Measured | |
|---|---|
| Lines | **2,645** |
| `any(text, …)` keyword matches | **134** |
| Regex literals over the raw prompt | **101** |

It is reached from `handle.ts:832` via `routeMessage(message)`, and the workspace calls
`POST /api/copilot` at **two** places (`copilot-workspace.tsx:1857` and `:2406`). Sample:

```ts
if (any(text, "park", "lend", "earn", "yield") && !any(text, "farm blend only")) {
  const earnAsset = /\bxlm\b/i.test(raw) ? "XLM" : asset;
  const earnAmtM = raw.match(/(\d+(?:\.\d+)?)\s*(?:on\s+)?(?:earn|vanna)\b/i) || …
```

That is keyword routing with a literal phrase exclusion, choosing an asset and an amount from
the prompt string. **It is exactly what Aditya ruled out**, and it explains why early screens
looked scripted: those turns went through `routeMessage`, not the investigation loop.

**This is now the single biggest thing standing between the copilot and "pure understanding".**
Cleaning `investigation/**` while `router.ts` still answers a share of live traffic means the
product has two brains and the user cannot tell which one replied.

**Decide and report the decision — do not start deleting 2,645 lines silently.** The options,
with my recommendation:

1. **Route everything through the investigation path** and reduce `/api/copilot` to a thin
   compatibility shim. Recommended. The investigation loop is now good enough to be the only
   brain, and this is the change that makes the claim true.
2. Keep `/api/copilot` only for the **page assistant** surface (no account access, explains the
   screen) where keyword routing is defensible, and make `/copilot` never call it.
3. Keep both. **Only if you can say which prompts each answers** — and then the health endpoint
   must report which brain served the turn.

Whichever you pick: **measure first.** Instrument both entry points for one battery run and
report what fraction of live `/copilot` turns still reach `routeMessage`. If it is zero, this
is a deletion. If it is not, that number is the answer to "how hardcoded are we."

---

## 2 · `ask.ts` moved the enumeration up a layer

This is the §3 rule from the last handoff, implemented — but implemented by **regex-matching
the model's own question text**:

```ts
export function isPreferenceGap(question: string): boolean {
  return /how long|holding period|horizon|\b\d+\s*(days?|weeks?|months?)\b/i.test(question)
    || /health (factor )?floor|risk appetite|how conservative|how aggressive/i.test(question)
    || /may i borrow|borrow against|permission to borrow|new (debt|borrow)/i.test(question);
}
```

The model writes a question in natural language; deterministic code then guesses **what kind of
question it is** from a phrase list. Ask *"what's your time frame?"* or *"how long are you
planning to hold?"* — neither matches — and `simplifyQuestion` **silently deletes the question**
whenever ranked options exist. That is the same failure as the original Finding 3, one layer up,
and the failure is invisible.

`BORROW_AUTHORITY` compounds it: a canned sentence **replaces** whatever the model actually
asked.

**Fix the mechanism: the model should emit the question already typed.** Have the research call
return the question as structured output — `{ text, kind: "preference" | "resolvable" }` — and
let `simplifyQuestion` read `kind`. The model knows why it is asking; do not make code infer it
from prose. Keep `isPreferenceGap` only as a fallback for an older continuation that predates
the field, and say so in a comment.

**Acceptance:** a question phrased in wording that appears in **no** regex in this file is still
classified correctly, and is not deleted when ranked options exist.

---

## 3 · The three live failures you reported — all the same missing step

You reported these honestly and they agree with what Aditya saw. They are one defect, not three:
**the system researches and lists, but does not commit to a decision.**

| Prompt | Observed | Missing |
|---|---|---|
| `put 10 xlm in and lever 3x into sousdc` | Deposit 10 XLM only | the sized borrow leg |
| `invest into earn pool where i can get good returns?` | Ranked live APRs vs balances | the pick, the reason, the Approve card |
| `where should I farm for the best yield right now` | 1m29s, loop `incomplete` at 23.5s | finishing at all |

**What "done" looks like, for all three:** read rates and balances → rank with a reason that
names the binding constraint (*"BLUSDC pays 29.08% but you hold none and funding it costs more
than the spread over 30 days, so AQUSDC at 7.84% on the 2,678 you already hold"*) → **one
recommendation** → a sized plan with real amounts → Approve → verify on Horizon.

Note what that sentence requires: the winner is **not** the highest APR. Ranking must be net of
what it costs to get there, over a stated horizon (last handoff §4). The earn run listed BLUSDC
at 29.08% with **0 held** — a rate the account cannot access — and did not say so.

For the 3× case: unit tests pass and the live path is deposit-only, so the failure is between
the compiler and the executor. Trace one live turn end to end before changing the compiler
again — the tests are asserting something the live path does not do.

For farm: the loop dies at 23.5 s on `max_borrow`, which I measured at **8.5–11.5 s** in MCP.
Gemini has been asked why. Do not cache over it.

---

## 4 · Still open, unchanged

- **`propose/route.ts:63`** — bare catch collapsing every failure into `proposal_unavailable`.
- **MCP handshake has no retry** — `getSession()` in `mcp-client.ts:396`, first network failure
  kills the turn. `retry-policy.ts` exists and is unused here.
- **§6 Langfuse** traces never dumped; **P3 Cloud SQL** not started.
- **Health endpoint does not report every gate.** `research-config.ts` now has distinct codes —
  surface them in `getBrainHealth()` (`handle.ts:145`). The rule: *no gate may exist that the
  health endpoint cannot report.* Third gate this month that failed closed and invisibly.
- **`asset-readiness.ts:78`** maps bare `USDC → BLUSDC`. That contradicts "bare USDC is a
  question" and is a hardcoded protocol assumption. Report whether it is live before touching it.
- **Nothing is committed.** 77 files. Ask Aditya before committing, but do not let this grow.

---

## 5 · Order

1. **§1 measure** which brain serves live turns — one number, and it decides the next week.
2. **§2 typed question** — small, and it stops silent question deletion.
3. **§3 decide-and-size** — the actual product gap.
4. **§4** leftovers.

Report in the standard format with **actual values**. **If a claim in this document is wrong,
say which and what the truth was** — I have been wrong in this project before and want to know.
