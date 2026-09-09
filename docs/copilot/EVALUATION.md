# Copilot evaluation — required scenarios vs actual coverage

Phase 6 of [FLASH_AGENT_UPGRADE_PLAN.md](./FLASH_AGENT_UPGRADE_PLAN.md) asks for an
evaluation suite over ten named scenarios, using "recorded/synthetic fixtures without
credentials". This file is the audit: each scenario maps to the tests that actually assert
it, and where nothing asserts it, it says so instead of claiming a pass.

Every row below runs with **no credentials and no model call** unless marked otherwise, so
the suite costs nothing to run and cannot be made green by a lucky live response.

Baseline at last update: `npx tsc --noEmit` clean, `npx vitest run` = **1399 passed, 2
skipped** (the 2 skips are the opt-in paid Vertex smoke and the opt-in live Firestore test).

---

## The ten scenarios

### 1. Owner USDC/XLM strategy, with and without funds; no arbitrary 1,000 USDC deposit

**Covered.** Every amount is computed, and an amount that cannot be computed is not shown.

- `investigation-capacity.test.ts` — headroom comes from the app's own
  `computeMarginSnapshot`, and is absent when the user stated no floor.
- `investigation-candidates.test.ts` — "offers no idle candidate when there is nothing
  idle, rather than a zero-size one"; idle value is per-token, so a combined total cannot
  fund a token the account does not hold.
- `workflow-journal.test.ts` — "refuses to hold a proposal whose amount is still a
  sentinel or zero" (`unsized_proposal_step`). A round invented number cannot reach an
  approval screen, because a proposal without a resolved amount is refused outright.

### 2. Unseen paraphrases, typos, mixed questions/actions, follow-ups

**Partial.** The floor parser and the follow-up path are tested; there is no held-out
paraphrase corpus.

- `min-health-factor-floor.test.ts` — floor phrasings including negation stated before the
  noun ("do not let the health factor dip below 1.25"), and "does not invent a floor from
  an unrelated number".
- `investigation-capacity.test.ts` — "takes the latest floor the user gave, not the first".
- `investigation-evidence.test.ts` — the sealed continuation "retains the whole objective",
  so a follow-up cannot silently drop an earlier constraint.
- `tests/hooks/use-investigation-continuation.test.tsx` — only a reply to an open question
  continues a thread.

**Gap:** a corpus of held-out rephrasings scored for completion and unnecessary
clarification. Writing one is a measurement exercise, not a fix, and it needs the metrics
in the "Not yet instrumented" section below to be worth anything.

### 3. "You may borrow" vs "do not borrow" vs "borrow this exact amount"

**Covered**, including the third case, which was wrong until it was fixed.

- `investigation-service.test.ts` — comparisons are published per borrowing scope, and
  supply-venue evidence survives a "do not borrow" so a debt-free option can still be built.
- `investigation-candidates.test.ts` — `borrowingAllowed: false` yields only the no-debt
  shape; `tests/components/investigation-card-options.test.tsx` asserts the borrow shape is
  absent from the DOM entirely, not merely ranked last or shown as ruled out.
- `investigation-candidates.test.ts` §"an amount the user named outright" — a stated $500
  is sized at $500, **not** at the floor. Before this, naming an amount produced a
  floor-sized proposal: a request to borrow $500 rendered as $6,541.
- An amount that will not fit is refused with the figure that would
  ("At most 6541.043333333333333333 USD fits") and never quietly reduced.
- An amount that cannot be valued from a price read this turn yields **no options at all**,
  plus a warning naming the asset. Sizing to the floor there would answer a question the
  user did not ask.

### 4. Multiple USDC variants, missing wallet binding, mismatched account

**Covered.**

- `investigation-rate-comparison.test.ts` — "maps Blend's USDC to BLUSDC but never AQUSDC".
- `investigation-runtime.test.ts` — "does not expose account or wallet reads without a
  server-resolved wallet"; "binds account arguments outside the model".
- `service.ts`'s `scopedMcp` wrapper raises `response_scope_mismatch` if any read comes back
  carrying a different identity; `investigation-evidence.test.ts` proves the continuation
  binds subject, trader, smart account, network **and** server independently.
- `workflow-journal.test.ts` — a record belonging to another subject reads as
  `workflow_not_found`, so a wrong identity cannot even confirm the plan exists.

### 5. Borrow cost exceeds expected income; no beneficial feasible strategy

**Covered.**

- `investigation-candidates.test.ts` — a negative carry is **rejected with its reason**, not
  ranked below the others where it could still be picked; an exactly-break-even carry is
  rejected too, because it is not a strategy.
- "reports no headroom as a reason rather than an empty result" — the absence of an option
  is stated, so "nothing shown" never has to be read as "nothing considered".

### 6. Stale or failed reads; conflicting evidence; instruction-like text in tool output

**Covered.**

- `investigation-rate-comparison.test.ts` — "rejects failed, stale, future and conflicting
  duplicate reads".
- `investigation-runtime.test.ts` — "rejects stale evidence even if the run still has time";
  "rejects oversized data without turning truncated financial values into facts"; "redacts
  secret fields before observations reach the model"; "does not share or allow the model to
  mutate request evidence".
- `investigation-evidence.test.ts` — "does not invent prices after errors".
- `domain-firewall.test.ts` — instruction-like text in ingested content.
- `investigation-candidates.test.ts` — a stale price values nothing, and a failed wallet read
  produces `null` rather than a partial total.

### 7. Read-only deployment, failed delegated signing, expired approval, replayed approval

**Covered, with one scenario deliberately retired.**

- **Read-only deployment: no longer applicable.** `COPILOT_READS_ONLY` was removed at the
  owner's explicit instruction ("no safety is needed … shouldn't matter for read or write")
  after it silently disabled every write on the deployed site. There is no read-only mode
  left to evaluate. See [[copilot-reads-only-gate-blocked-all-writes]].
- **Failed delegated signing:** `investigation-evidence.test.ts` — "does not report a
  configured-but-dead delegated session as active authority". `enabled: true` alongside
  `session_expired` / `no_active_session` / `over_daily_cap` / `unauthorized` now renders
  "Not usable (…)" with a warning that every transaction still needs the user's wallet.
  Reading only `enabled` had labelled a dead session "Active".
- **Expired approval:** `workflow-journal.test.ts` — expiry refuses approval, and expiry
  *during* validation blocks it rather than completing.
- **Replayed approval:** `approval_already_consumed`, plus "allows one validation and one MCP
  claim despite concurrent requests" — 8 simultaneous approvals produce exactly 1 validation.
  `write-dedupe.ts` is the second, coarser gate.

### 8. Quote movement between proposal and approval; bounded sizing vs material change

**Partial.**

- Covered: the proposal's `revision` + `digest` must match at approval, so any change to the
  canonical form invalidates it; `validate` runs fresh reads at approval time; and
  `claimNext`'s readiness check re-runs **before each step is broadcast**, so a price move
  between leg one and leg two blocks the run rather than pushing it through. Refusing sets
  the run `blocked` and leaves the step unclaimable — recovery is a new proposal.
- A readiness check that throws is treated as a refusal, never as a pass.

**Gap:** *bounded* downstream sizing — leg two spending leg one's actual output — is not
supported. `ProposalStep` carries no dependency or bound, so it is refused as unsized rather
than admitted as an unbounded "max". That is the safe direction, but it means multi-leg
shapes needing it (swap → add liquidity) cannot be expressed as a journal proposal yet.

### 9. Transaction timeout, repeated submission, browser refresh, partial settlement

**Partial.**

- Covered: one claim per step under concurrency; an `uncertain` tool outcome blocks the run
  instead of re-issuing the write; `settled` accepts only the matching hash and reports
  `completed` only when every step settled; and `reconcile` resolves an uncertain step by
  **asking the ledger about the recorded reference** — settling it, stopping the run if it
  failed, or freeing it for a genuine retry only once the ledger shows nothing was spent.
- With no recorded reference, `reconcile` refuses (`unreconcilable_without_reference`) rather
  than searching recent account activity and guessing which transaction was ours.

**Gap:** browser refresh mid-run. The server-held record is designed to be the source of
truth, but no route exposes it yet (see Status below), so the client cannot resume from it.

### 10. Unsupported requests: precise limitation, no invented tools, no canned plan

**Covered.**

- `investigation-runtime.test.ts` — "does not fallback to a canned plan when the model
  fails"; "returns an explicit incomplete outcome when turns run out"; an invalid capability
  in a batch spends no read.
- `service.ts` publishes deterministic facts and the next clarification only — model prose
  is never promoted to a recommendation.

---

## Status: what is built vs what is on the live path

The Phase 4/5 machinery is a **verified library that no route calls yet**.
`WorkflowJournal` and `RecordStore` are covered by 15 + 8 tests and are referenced by
nothing under `app/`. Until a route is wired, the live surface still runs the pre-existing
write path, and the guarantees described in scenarios 7–9 protect the journal, not yet the
button the owner clicks. This is the single most important caveat in this document.

Storage, honestly stated:

- `LocalRecordStore` (dev) — immutable revisions, fsync before atomic publication.
- `FirestoreRecordStore` (Cloud Run) — `updateTime` preconditions used as compare-and-set.
- `workflowStore()` **throws** `durable_workflow_store_not_configured` in production when
  unconfigured, rather than silently falling back to a process-local map that would lose
  approvals on restart and diverge across replicas.
- The Firestore access needed to make that real was **not granted**: the request to give
  `vanna-app-run@vanna-main.iam.gserviceaccount.com` read/write on the `copilot-workflows`
  database was rejected by automatic approval review. No access was granted and none was
  retried. Deploying as-is fails loudly at startup of the first workflow write, which is the
  correct behaviour, but it does mean Phase 5's durability requirement is **blocked on an
  owner-side permission grant**, not on code.

## Not yet instrumented

The plan's release gates include tracking "completion rate, unnecessary clarification rate,
missing-constraint rate, tool/turn count, input/output tokens, latency and estimated cost",
and explicitly say to "establish live baselines before choosing numeric latency/cost
targets". None of that is instrumented. `runInvestigation` returns `usage`, and the timeout
budget is asserted in `investigation-timeout-budget.test.ts`, but nothing aggregates either.

Stating a numeric latency or cost target now would be inventing a baseline rather than
measuring one.

## Cost note

Nothing in this audit's coverage requires a model call. Phases 3–5 moved work in the
cheap direction on purpose: sizing, headroom, candidate generation, ranking, carry rejection
and every health-factor projection are deterministic code, so the model chooses *shapes* and
never numbers. The two paid tests are opt-in behind env flags
(`RUN_FLASH_INVESTIGATION_EVAL=1`, and the live Firestore test) and are skipped by default.
