# Handoff — measure the planner, then make the copilot commit to a decision

**For:** Gemini 3.8 Flash (Antigravity). **Author:** Claude, auditor. **Created:** 13 Sep 2026.
**Repo:** `vanna-copilot-orchestrator`, branch `copilot-upgrade` — **this repo only.**
**Picking up from:** Grok/Hermes, which ran out of credits mid-pass. 106 files uncommitted.

**Baseline I measured myself, this turn — not taken from anyone's report:**
`npx tsc --noEmit` exit **0** · `npx vitest run` → **1694 passed / 0 failed / 3 skipped**.

---

## 0 · The two rules that govern this pass

**1. Never hardcode.** A fix that names a capability, tool, symbol, field, venue, phrase or
magic number is not a fix — it works once and leaves the next case broken identically. Fix the
mechanism, then prove it on an input **nobody enumerated**. If the generalised fix is much more
work, **say so and let Aditya decide** — never quietly ship the enumerated one.

**2. Report actual values, never "verified".** Paste the real response body, the real counter,
the real duration, the real revision id. Every agent on this project — Grok, Gemini and the
auditor — has had a confident claim fail checking. The reporting format is what makes the loop
safe, not the model. Two real examples, both from this project:

- A deploy report listed *"a read-scoped token sees no write tools"* as a **passing** security
  criterion. The observation was true; the token was **the app's own production credential**.
  The criterion and a production outage were the same sentence.
- Two criteria were reported "verified" that had only been **read in source**, never called.

If a claim in this document is wrong, **say which and what the truth was.** I have been wrong
here twice this week and want to know.

Standing rules: copilot code only (report bugs in shared app libraries, do not fix them), no
commits/pushes without asking, no PR from `copilot-upgrade`, `dev` is read-only.

---

## 1 · Skills in these repos you should actually use

They are plain markdown; read them directly.

| Skill | Path | Use it for |
|---|---|---|
| `stress-test-copilot` | `.claude/skills/stress-test-copilot/` | Running a battery, classifying results, logging to `PROMPT-LIBRARY.md` |
| `generate-test-prompts` | `.claude/skills/generate-test-prompts/` | Writing prompts a real user would type — **not** synthetic ones |
| `ship-across-repos` | `.claude/skills/ship-across-repos/` | Anything touching both app and `vanna_mcp` |
| `deploy-mcp-services` | `.claude/skills/deploy-mcp-services/` | Verify-before-deploy; someone may already have deployed |

A note on prompts, learned the hard way: the auditor once wrote the battery prompt
*"use USDC and BLUSDC so my health factor stays above 1.3"*. Nobody talks like that, and it
produced a misleading result that cost a full test round. **Use Aditya's phrasing, or the
skill's, never your own invention.**

---

## 2 · Task A — get the number  *(small, and it decides priorities)*

`GET /api/copilot` now reports `brains_served`. It currently reads
`{ investigation: 0, keyword_router: 0, copilot_shim: 0 }` — that is a **fresh process**, so the
instrument exists and has produced **no data**. Zero-in-a-fresh-process proves nothing.

**Do:** start the dev server (it is **not running** as of this writing), run a battery of
free-text prompts through `/copilot`, then `GET /api/copilot` and paste the counters.

**Why it matters:** it settles whether `router.ts` (2,645 lines, 134 keyword matches, 101
regexes) still serves any planning traffic. Verified code path today: `handle.ts:823` returns
`investigation_owns_planning` for `surface === "copilot"` **before** `routeMessage`, so the
expected answer is `keyword_router: 0` for planning. **Confirm it empirically rather than
trusting the read** — including me; I asserted the opposite two days ago from a stale reading
and was wrong.

**Acceptance:** non-zero counters pasted verbatim, plus the prompt list that produced them.

---

## 3 · Task B — the environment blocks live testing  *(do before Task C)*

Live retests could not complete. Measured on the running app:

| Endpoint | Observed |
|---|---|
| `GET /api/analytics/accounts` | **5.0 min** (repeatedly, 3.7–5.4 min) |
| `computeMarginSnapshot` | 12 s timeout, `SnapshotTimeoutError` |
| `GET /api/account/<G…>` | 6–13 s, intermittent **502** |
| `soroban-testnet.stellar.org` | frequent `ECONNRESET`, one Cloudflare **524** |

`/api/analytics/accounts` and `computeMarginSnapshot` are **app-team libraries — report them,
do not fix them.** Write the numbers into `docs/copilot/app-team/BUGS-FOR-APP-TEAM.md` with the
timestamps.

The Soroban RPC resets are upstream and not ours. If they make a run unreproducible, say the run
was inconclusive — **do not report a copilot failure that was actually an RPC failure.** That
mistake has already been made once on this project.

---

## 4 · Task C — make it commit to a decision  *(the actual product gap)*

Three prompts, one defect: **the system researches and lists, but never commits.**

| Prompt | Last observed | Missing |
|---|---|---|
| `put 10 xlm in and lever 3x into sousdc` | Deposit 10 XLM only | the sized borrow leg |
| `invest into earn pool where i can get good returns?` | Listed live APRs vs balances | the pick, the reason, the Approve card |
| `where should I farm for the best yield right now` | 1m29s, loop `incomplete` at 23.5 s | finishing at all |

**Done means, for each:** rank net of cost over a stated horizon → **one** recommendation naming
the binding constraint → a sized plan with real amounts → Approve → verify on Horizon.

**Already fixed upstream of you — do not redo it.** Holdings now span all three buckets and name
the constraint. Verified in `candidates.ts`:

> *"BLUSDC Earn pays 29.08% but spendable wallet BLUSDC is 0. Posted margin holds 552; Earn
> already holds 203. That rate is not a deposit you can make this turn."*

That is the standard for every "binding constraint" message: name the buckets and why the rate
is out of reach, rather than omitting the option.

**For the 3× case:** unit tests pass and the live path is deposit-only, so the tests assert
something the live path does not do. **Trace one live turn end to end before touching the
compiler again.** Grok already made Nx compile return `null` rather than fall through to
deposit-only when prices fail — confirm that is what you see live, then find the real divergence.

**For farm:** the loop dies at 23.5 s on `max_borrow`, which measures **8.5–11.5 s** server-side
in MCP. Do not cache over it; find out why it is slow.

---

## 5 · The health-factor floor — read this before touching anything near it

**1.10 is a protocol fact** from RiskEngine: healthy iff HF > 1.10, liquidatable at HF ≤ 1.10.
It is imported as `LIQUIDATION_THRESHOLD_WAD`. **It is not a preference and is never
overridden.**

**A plan's floor is the user's preference**, and the codebase currently enforces that correctly:
`capacity.ts:208` returns `null` when no floor was stated, which makes `borrowingAllowed` false,
so no borrow candidate is generated at all. The comment says it: *"The floor must come from the
user."*

**Do not add a default floor to the leverage path.** A proposal to apply "a default 1.30 floor on
3× approve" was raised and rejected by Aditya — it would push an invented number into sizing and
break the invariant above. `1.30` is not derived from anything.

One disclosed default survives at `proposal.ts:66` on the `requested_actions` path, and it does
label itself (*"1.30 (default; say a different floor to change it)"*). Leave it alone this pass.
The right long-term fix is to ask once and remember it in the thread — a floor is a preference,
and the thread now persists — but that is a product decision for Aditya, **not yours to make**.

---

## 6 · Leftovers

- `propose/route.ts` — abort now maps to `proposal_aborted` 504; other failures still collapse to
  `proposal_unavailable` but now carry `cause`. Verify the cause actually survives.
- **Langfuse §6** traces never dumped; **P3 Cloud SQL** not started.
- `asset-readiness.ts:78` maps bare `USDC → BLUSDC` and is live. It contradicts "bare USDC is a
  question". Report whether it affects planning or only trustline copy — **do not change it**
  without saying what you found.
- **106 files uncommitted.** No restore point. Ask Aditya before committing; do not let it grow.

---

## 7 · Order, and the report

1. **Task B** — unblock the environment, or nothing below is measurable.
2. **Task A** — one number.
3. **Task C** — the product gap, in the order earn → 3× → farm.
4. **§6** leftovers.

```
**Done** / **Verified** / **Not done or blocked** / **Deviations** / **New findings**
**Suite:** tsc <clean|errors> · vitest <pass>/<fail>/<skip>
```

`vitest` means the **full suite**, not a selected subset — a previous report gave "39 passed"
from selected files, which is not a suite result. Run `npx vitest run` with no path.
