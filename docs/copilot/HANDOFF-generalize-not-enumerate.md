# Handoff — generalise the copilot, then finish the remaining phases

**For:** Grok (Cursor). **Author:** Claude, auditor. **Created:** 11 Sep 2026.
**Repo:** `vanna-copilot-orchestrator`, branch `copilot-upgrade` — **this repo only.**
**Baseline:** `tsc` clean · vitest **1650 / 0 / 3**.

---

## 0. The rule that governs this entire pass

**A fix that names a capability, tool, symbol, field, venue or phrase is not a fix.**

It works for the one case in front of you and leaves the next one broken identically. Fix the
mechanism, then prove it on an input **nobody enumerated**.

This is not style advice. The first signed-in battery was run today and the copilot looked
scripted — because in the places that matter it is. Every finding below is an instance of the
same defect: capability that should live in the model, or be derived from data, was moved into
a hand-maintained list instead.

For every task, the acceptance test is written as *"something not in any list now works."*
If your change cannot pass that test, it is the wrong change. **If the generalised fix is
substantially more work than the enumerated one, say so in your report and let Aditya decide —
do not quietly ship the enumerated version.**

Standing rules, unchanged: copilot code only (report bugs in shared app libs, do not fix them),
no commits, no pushes, no PR from `copilot-upgrade`, `dev` is read-only.

Report once at the end:

```
**Done** / **Verified** / **Not done or blocked** / **Deviations** / **New findings**
**Suite:** tsc <clean|errors> · vitest <pass>/<fail>/<skip>
```

Report **actual values**, not "verified". **If a claim in this document is wrong, say which
and what the truth was.**

---

## 1 · Every option button is dead  *(do this first — it is 30 minutes and it unblocks testing)*

**Proven.** `POST /api/copilot/workflow/propose` returns **400** on every click of *Prepare
this plan* and *Switch →*. The card then renders the route's own rejection text:
*"Send the investigation continuation and the option to prepare only…"*

`app/api/copilot/workflow/propose/route.ts:32` requires:

```
/^[a-z0-9_]{1,80}$/          ← lowercase only
```

`lib/copilot/investigation/candidates.ts:233` produces:

```ts
id:    `supply_idle_${comparison.asset}`,      // → supply_idle_BLUSDC
label: `Supply idle ${comparison.asset} to Blend — no new borrowing`,
```

The rendered label reads **"Supply idle BLUSDC"**, so the id carries the same uppercase symbol
and fails the regex. Three id shapes are affected: `supply_idle_`, `lend_idle_`,
`borrow_supply_`.

**Do not fix this by lowercasing at the three call sites.** One module owns candidate ids:
it mints them and exposes the validator the route uses, so a producer and a consumer can never
again disagree about the shape by coincidence.

**Acceptance:** add a fourth candidate kind with a symbol containing a digit and a hyphen,
touch neither the route nor its regex, and its button works.

---

## 2 · A successful read is being reported as unavailable  *(the headline defect)*

**Proven from the run log:**

```
tool: 'vanna_get_max_borrow', ms: 8500, keys: [... 'max_borrow_human', 'limiting_factor' ...]
investigation fact extract { capability: 'max_borrow', status: 'ok', kind: 'no_fields' }
```

The read succeeded and the number was present. The user was told
*"max borrow: no supported display fields were available."*

`lib/copilot/investigation/normalize.ts` is a **14-case switch over capability names**. The
loop may call roughly 24 reads. `max_borrow_human` is extracted in exactly one branch —
`case "can_borrow"` — which is a **different tool**. There is no `case "max_borrow"`, so every
fact from it is discarded and a warning is emitted claiming the data was missing.

This is the mechanism that makes the copilot feel templated. It also silently caps what the
model can ever say: reads outside the 14 branches cannot reach the answer no matter how good
they are.

**The fix is to derive facts from the response shape, not from the capability name.** The MCP
responses already carry their own meaning in the key names and units — `*_human`, `*_usd`,
`*_pct`, `*_wad`, `*_address`, plus `duration_ms` which is never a fact. Build the extractor
from those conventions, with unit and label inferred from the suffix and the key path.

Keep the hand-written branches **only** where a branch encodes a real judgement that a shape
cannot express — `signing_status` is the clear one: `enabled: true` alongside a contradicting
`status` must not read as "Active", and that reasoning is not derivable from shape. Where you
keep a branch, say in a comment why shape alone is insufficient.

**Acceptance:** delete no MCP tool, add no case, and `max_borrow` renders its number. Then
point the loop at a capability that has never had a branch and confirm it renders too.
`kind: 'no_fields'` should become rare enough that its appearance is a real signal.

---

## 3 · Clarify vs rank — the two halves of last pass cancelled out

The thread was built so a clarifying question can be answered. The same pass then **removed
the clarifying question**: *"Compound 'how much / which variant' questions are dropped when
ranking exists."* Net effect in the live battery: the copilot asked nothing, so there was
nothing to reply to, and repeated replies (`use blusdc`, `yes`) just re-ran the same
restatement.

Neither behaviour is wrong. The missing piece is a written rule about which one applies.

**Adopt this and put it in code as one predicate, not scattered conditions:**

- **Rank and decide** when the alternatives are **comparable from evidence already read** —
  which USDC variant, which venue, which pool. The system has the rates; asking is a cop-out.
  State the winner and the reason, and offer the runner-up.
- **Ask one closed question** when the missing input is a **preference that no read can
  supply** — holding horizon, risk appetite, whether borrowing is permitted, a health floor
  when none was given.

The test is not "is this ambiguous" but **"could any read resolve it?"** If yes, resolve it.

**Acceptance:** `supply my USDC to the best pool` ranks and commits without asking.
A prompt whose only gap is a preference asks exactly one question, and a reply in the thread
continues the same investigation rather than starting a new one.

---

## 4 · "Costs more than it gains" is not an analysis

The ranked card said: *"AQUSDC pays 11.2% more but you'd swap 2,680 first, which costs more
than it gains."*

**Over what period?** A swap cost is one-time; an APR gap is per year. With no horizon in the
comparison, that sentence rejects **every** swap forever, regardless of size or spread — and
it will keep steering to whatever is already held. That is a hardcoded bias wearing the
clothes of a calculation.

Net return must be evaluated over a **stated horizon**, and the horizon must appear in the
explanation. By §3 the horizon is a preference, so: use an explicit default, say it out loud
("over 30 days"), and let the thread change it. Never emit a cost-vs-gain verdict without the
period it was computed over.

**Acceptance:** the same comparison flips to recommending the swap at a long enough horizon,
and the sentence names the horizon in both directions.

Related: the ranked list included **BLUSDC at 30.58%**, the highest rate on screen, but the
headline prose discussed only SOUSDC and AQUSDC. The ranking and the explanation are generated
from different places and disagree. The explanation must be generated from the ranking result,
not assembled alongside it.

---

## 5 · An aborted request is reported as a timeout

```
POST /api/copilot/investigate 200 in 4.6s
investigation position seed failed { error: { name: 'ResponseAborted', message: '' } }
loop: outcome 'stopped', modelTurns: 0, toolCalls: 0
turn: status 'incomplete'
```

4.6 seconds, zero model turns — and the user was told *"The investigation ran out of time
before it could finish."* Two different causes share one message, which has already cost
debugging time on the wrong thing.

Work also continued **after** the response closed, which is why it was aborted at all. Bound
the work to the request, and separate the copy: a deadline says time ran out; an abort says
the request was replaced or cancelled and offers to retry.

**Acceptance:** trigger both paths deliberately; they produce different messages, and the
abort path does not log at error level.

---

## 6 · Strategy prompts are still too slow — measure before changing

Live, this pass: `repay 1 xlm` sat at *"Preparing your session · 1m 51s"*; `deposit 5 XLM as
collateral` ended in the incomplete path; `borrow as much as possible but stay completely safe`
never finished.

Named costs already visible in the logs — **do not optimise anything not on this list until
you have a trace showing it**:

| Span | Observed |
|---|---|
| `vanna_get_max_borrow` | **8.5 s**, and **11.5 s** on a second run |
| `vanna_list_my_wallet_bindings` (scope, cold) | **6.6 s** |
| Vertex turn 2 | ~9 s, `thoughts=941` |
| `investigation.loop` | 21–25 s to `research_complete` |

`vanna_get_max_borrow` is the single largest read and its result is currently **discarded** by
§2 — so today the loop pays 8–11 s for a number the user never sees. Fixing §2 may change the
picture enough that you should re-measure before tuning anything else.

Use the Langfuse traces. Name the dominant span with a number before touching it.

---

## 7 · Still open from previous passes

- **`app/api/copilot/workflow/propose/route.ts:63`** — bare catch turning any failure into
  `proposal_unavailable`. Third instance of the swallowed-error class; the other two are fixed.
  Preserve the cause.
- **MCP handshake has no retry.** `getSession()` in `lib/copilot/mcp-client.ts:396` throws
  `MCPCallError` on the first network failure. `call()` retries only a *stale session*, which
  is a different case. `lib/copilot/retry-policy.ts` exists and is not used here. Retry twice
  with backoff on a network throw; leave the timeout and auth branches alone.
- **P3 Cloud SQL** — schema written, no instance provisioned, threads do not survive a deploy.
  Do not invent an instance.
- **P4 / P5 / P6** — as last reported.

`.env.local` currently points `MCP_BASE_URL` at the direct Cloud Run URL as a temporary local
workaround. **Do not commit it and do not change `cloudbuild.yaml`**, which correctly uses
`https://mcp.vanna.finance/mcp`.

---

## 8 · Order, and what "done" means

1. **§1 ids** — nothing can be tested until buttons work.
2. **§2 normalizer** — the headline defect, and it may change §6.
3. **§5 abort vs deadline** — small, and it stops mis-diagnosis.
4. **§3 clarify-vs-rank** and **§4 horizon** — these two are one coherent change to how a
   decision is explained.
5. **§6 latency**, re-measured after §2.
6. **§7** leftovers.

Then run the battery yourself before reporting: the owner paragraph, a bare
`supply my USDC to the best pool`, a three-turn refinement, and one small write with
auto-approve **on** and again with it **off**. Log each result verbatim to
`docs/copilot/PROMPT-LIBRARY.md` with the cause when it fails.

**Do not report "done" on any task whose acceptance test is "something not in a list now
works" until you have actually run that test on an un-enumerated input.**
