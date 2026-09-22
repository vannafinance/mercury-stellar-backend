# Vanna / Ori copilot intelligence upgrade

Created: 2026-09-08. Status: development started; production behavior has not been migrated.

## 1. Outcome and agreed constraints

Build a Gemini Flash copilot that understands a user's objective, investigates live state through MCP, evaluates feasible actions, presents a concrete proposal, executes within approval, and verifies the outcome.

The owner's acceptance example is: “Use both USDC and XLM to build a strategy so health factor does not go below 1.3. You can use spot and farm markets yourself. You can even take new loans.”

Expected behavior:

1. Explain that the copilot will inspect balances, debt, markets, and available signing capabilities.
2. Obtain those facts through read tools. Do not invent an investment amount or treat permission to borrow as an obligation to borrow.
3. Clarify material choices that evidence cannot resolve, such as investment budget, objective, or an ambiguous token variant. Do not ask the user for facts tools can obtain.
4. Compare feasible candidates against the stated objective and constraints, including a non-borrowing alternative when relevant.
5. Compute sizes and intermediate/final position effects with deterministic domain code.
6. Present an evidence-backed proposal with amounts or bounded sizing rules, venues, expected effects, limitations, and approval scope.
7. Execute only after valid approval or within an existing explicitly authorized mandate.
8. Confirm settlement and read back resulting positions. Report partial completion honestly.

All reasoning stays on **Gemini Flash**. No Claude, Pro, or other-provider fallback. Gemini 3.8 Flash is the preferred candidate, subject to authenticated availability and task evaluation in our Google project. Google publishes a [3.8 Flash model page](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash?authuser=0) and [developer guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash?authuser=0). An authenticated 3.8 smoke test passed during Phase 1; this does not replace broader task evaluation. Production model configuration remains unchanged. The new research adapter uses `MEDIUM` thinking on Gemini 3 and omits the sampling parameters retired by 3.8.

“Intelligent” means correct and adaptive behavior across supported Vanna workflows. It does not mean unlimited tool access, guaranteed market outcomes, or invisible transaction authority. No training on changing balances or prices.

## 2. Current implementation and migration boundaries

- `lib/copilot/llm-planner.ts`: one-shot write-plan generation; no investigative tools or market observations.
- `lib/copilot/handle.ts`: keyword routing, native model routing, deterministic overrides, plan merging, approval, and execution in one large flow.
- `lib/copilot/plan-ir.ts`: existing constraint and clause-coverage representation; preserve useful checks while expanding semantic goal support.
- `lib/copilot/plan-approval.ts`: plan fingerprinting and expiry. Audit and extend to authenticated server-held approval records; a client-recomputed hash alone is not authorization.
- `lib/copilot/risk.ts`: risk projection exists, but guessed fallback prices must not support safety-critical decisions.
- `lib/copilot/multi-leg-preflight.ts` and `handle.ts`: move critical feasibility checks before approval and make missing critical evidence block dependent actions.
- `lib/copilot/mcp-client.ts`: reuse authenticated MCP transport, without exposing unrestricted calls to the investigator.
- `components/copilot/copilot-workspace.tsx`: preserve working execution UI; reconcile client-only autonomy with real server policy.
- `../vanna_mcp/vanna-mcp/mcp_server/tools/`: existing market, wallet, account, risk, signing, and execution tools. Some writes can auto-sign; investigation must expose only audited reads.

The supplied screenshots document observed behavior, but their exact deployed commit and runtime trace are not known. Do not assert that every screenshot defect reproduces on this checkout. Ori-specific adapters and UI must be located/audited before claiming Ori integration.

## 3. Architecture

```text
Authenticated request + recent conversation + server task state
  -> Flash decision loop
     -> audited read capabilities -> timestamped evidence -> next Flash decision
     -> clarification / blocked investigation / research complete
  -> deterministic candidate evaluation and sizing
  -> validated proposal + evidence references
  -> server-held approval bound to user, wallet, network, and plan version
  -> durable executor -> settlement verification -> refreshed state
  -> outcome report / remaining work / authorized recovery
```

The model may choose what to inspect and suggest candidates. It cannot authorize transactions, supply its own wallet identity, waive constraints, invent evidence, or decide that a transaction settled. Tool outputs, page text, and conversation history are untrusted data; they do not override system policy or grant authorization.

### Core contracts

- **Goal:** objective; asset/venue scope; mandatory constraints; allowed actions; explicit prohibitions; unresolved choices. Borrowing permission is distinct from a borrowing instruction.
- **Observation:** capability; validated arguments; scoped identity; timestamp; result or explicit error; stable evidence ID. Failed/missing results never become zero balances or assumed prices.
- **Candidate:** proposed actions and funding dependencies; evidence inputs; deterministic evaluation; unsupported assumptions and rejection reasons.
- **Proposal:** resolved amounts or precisely bounded rules; all material constraints; effect after every step; evidence freshness; expiry; required signing authority.
- **Approval:** authenticated server record for a specific proposal version and execution scope. Changes outside that scope require renewed approval.
- **Run:** persistent step states, idempotency keys, transaction references, settlement observations, and recovery status.

Maintain concise decision summaries, evidence and tool events for debugging. Do not collect or display private chain-of-thought. Bound model output, tool payloads, number of turns/calls, elapsed time, and retries. Exceeding a budget returns an explicit incomplete state, not a fabricated plan.

## 4. Phases and delivery gates

| Phase | Work | Exit gate | Dependencies |
|---|---|---|---|
| 0 — Plan and baseline | This document, owner scenarios, existing-flow map, Flash constraint, initial evaluation criteria | Reviewable plan exists before code changes; baseline limits documented | None |
| 1 — Investigation foundation | Typed decisions/evidence; strict read capability registry; identity binding; bounded adaptive loop; Gemini Flash adapter; offline behavioral tests | Loop consumes read results before its next decision; rejects writes, unknown arguments, forged evidence and non-Flash models; explicit failure/budget handling | 0 |
| 2 — Product context and conversation | Expand live reads, normalize account/market state, server task memory, semantic goals, workflow knowledge, read-only UI integration | Owner prompt triggers meaningful live investigation; follow-ups preserve scope/constraints; no unsupported executable proposal | 1 |
| 3 — Strategy evaluation | Candidate generation; deterministic sizing, cash flow, fees, borrow costs, liquidity and risk checks; intermediate-state simulation; freshness rules | Owner scenario yields a feasible sized proposal or precise blocker; no guessed critical values; risky candidates rejected | 2 |
| 4 — Approval and capability consistency | Server-held proposal/approval records; authentication and identity binding; replay protection; pre-approval readiness; unified signing status | Approval executes only its scope; stale/changed plans revalidate; failed server sessions never appear server-authorized | 3 |
| 5 — Durable execution and verification | Persist runs; idempotency; transaction reconciliation; step readback; safe pause/resume; bounded recovery | Refresh, timeout and retry cannot duplicate writes; partial outcomes verified and reported | 4 |
| 6 — Evaluation and staged rollout | Live Flash comparison, held-out scenarios, testnet execution, telemetry, staged routing migration, Ori adapter validation | Gates below pass; controlled release with tested rollback; no unsupported claim of Ori coverage | 2–5 |

### Phase 1 implementation scope (first development slice)

Add a separately testable server-side investigation module under `lib/copilot/investigation/`. The module will use the existing Vertex authentication and MCP transport through narrowly typed adapters. The model chooses a read or ends with a clarification, blocker, or research handoff. Research completion is **not** approval or proof a strategy is safe.

Initial reads: wallet balances, account health/debt/collateral, Earn rates, token prices, and signing status where supported by audited MCP signatures. Bind account-scoped arguments in server code. Do not pass arbitrary composite `action` tools, signing tools, write tools, or model-selected addresses.

Add behavioral tests using controlled model decisions and MCP responses. These prove runtime boundaries, not live Flash reasoning quality. Keep the existing user-facing planner unchanged until Phase 2–4 integration gates are met. This first slice intentionally does not claim to complete the whole upgrade.

### Phase 2 context and experience

- Read network and protocol capabilities; resolve wallet/account relationships using authenticated context. A browser-supplied address is not proof of ownership.
- Distinguish wallet assets, margin collateral/debt, Earn positions, Blend positions, and LP positions; preserve canonical token identity and units.
- Carry recent dialogue plus a bounded server-side task summary. User preferences may persist; current prices and balances must be refreshed.
- Author versioned Vanna workflow knowledge and examples. Use retrieval if the knowledge set warrants it; do not introduce a vector database solely for a short tool catalog.
- Replace ad hoc phrase routing for migrated goal-driven requests with semantic decision output. Retain regression-tested deterministic execution primitives.
- Show real progress events (reading account, comparing markets, checking feasibility). Never display a cosmetic “thinking” sequence that did not occur.

### Phase 3 computation and financial constraints

- Select an objective explicitly: “build a strategy” alone does not specify maximum yield, minimum risk, or how much of the wallet to invest.
- Treat borrowing as optional unless explicitly required; account for current debt before recommending new debt.
- Audit protocol health-factor semantics across UI, MCP and contracts. Use one authoritative calculation, exact token-unit conversion, and conservative rounding.
- Track cash available after every leg, including reserves, origination fees, swaps, price impact and changing rates. Do not reuse the same funds across candidates or steps.
- Compare net outcomes on consistent time/unit assumptions; do not equate advertised supply APY with net strategy yield.
- Run stated stress scenarios where applicable; clearly distinguish forecast from guarantee. Monitoring cannot guarantee a permanent HF floor.
- Critical price/health/liquidity failures block dependent proposals. Optional missing data can reduce comparison scope if disclosed.
- Reuse existing risk and leverage helpers after auditing; remove silent guessed prices and critical fail-open preflight behavior in this phase.

### Phase 4 authorization

- Separate product plan approval, wallet signing, delegated signing policy, and ongoing automation authority.
- Store proposal canonical form and expiry on the server. Bind to authenticated subject, wallet, network, constraints, sizing bounds, and step dependencies.
- Verify plan freshness and execution readiness before the user approves and again before broadcasting.
- Resolve missing sizes before presenting an executable proposal, except explicitly described bounded downstream sizing from actual prior outputs.
- Do not label a failed server session as active server delegation. If local signing remains supported, give it distinct status and authority semantics.

### Phase 5 execution

- Persist runs and idempotency claims in an existing suitable durable store, selected after deployment/storage audit; process-local maps are insufficient.
- Reconcile unknown submission outcomes by transaction reference before retrying.
- Verify actual outputs and health after settlement; subsequent steps consume confirmed outputs within approved bounds.
- Stop when a constraint fails. Do not silently modify asset, amount, venue, or risk to get a transaction through.
- Recovery is a new proposal unless already covered by authorization; an irreversible transaction is not rolled back merely because later steps fail.
- Audit the guardian separately for durable scheduling, funding, permissions, and actual enforcement before promising unattended protection.

## 5. Evaluation suite and release criteria

Use recorded/synthetic fixtures without credentials for deterministic tests, a separate authenticated read-only model evaluation, and isolated testnet wallets for execution. Do not execute against the owner's wallet as a test.

Required scenarios:

1. Owner USDC/XLM strategy, with and without sufficient funds; no arbitrary 1,000 USDC deposit.
2. Same intent with unseen paraphrases, typos, mixed questions/actions, and follow-ups.
3. “You may borrow” versus “do not borrow” versus “borrow this exact amount.”
4. Multiple USDC variants, missing wallet binding, and a mismatched account.
5. Borrow cost exceeds expected income; no beneficial feasible strategy.
6. Stale or failed oracle/health/market reads; conflicting evidence; instruction-like text in tool output.
7. Read-only deployment, failed delegated signing setup, expired approval, and replayed approval.
8. Quote movement between proposal and approval; valid bounded sizing versus a material plan change.
9. Transaction timeout, repeated submission request, browser refresh and partial settlement.
10. Unsupported requests and capabilities: precise limitation without invented tools or a generic canned plan.

Release gates:

- Zero unauthorized writes, forged evidence acceptance, ignored mandatory constraints, cross-user observations, or duplicate submissions in the adversarial suite.
- Every proposed financial number traceable to explicit user input, fresh tool evidence, or deterministic calculation with recorded inputs.
- Every success claim backed by settled transaction/state verification.
- Owner scenario and its held-out paraphrases pass end to end; ordinary existing Earn/Farm/Margin actions retain regression coverage.
- Track completion rate, unnecessary clarification rate, missing-constraint rate, tool/turn count, input/output tokens, latency and estimated cost. Establish live baselines before choosing numeric latency/cost targets.
- Compare configured Flash and 3.8 Flash on identical held-out tasks. Deployment requires authenticated endpoint checks and schema compatibility, not just a model-name change.

## 6. Rollout, operations, and remaining decisions

Ship in bounded slices: offline tests -> read-only evaluation -> internal investigation surface -> validated proposals -> isolated testnet execution -> staged production routing. Record model ID, knowledge/tool registry version, trace ID, observations, validation verdict and settlement status. Redact tokens, assertions and signer secrets.

Roll back by disabling the new route; preserve durable run/approval records and reconcile already submitted transactions. Do not blindly route an unfinished goal back through a weaker keyword path that may discard its constraints.

Operational decisions to resolve through repository/deployment inspection: durable storage, available model endpoint, live MCP tool signatures, RPC rate limits, guardian scheduler, and Ori integration location. Ask the user only when a product choice or external access cannot be inferred; none of these block Phase 1.

## 7. Development record

- Plan written before implementation on 2026-09-08.
- Phase 1 foundation implemented under `lib/copilot/investigation/`: strict read catalog, scoped arguments, typed/validated research decisions, request-local evidence, bounded adaptive loop, and Flash-only Vertex adapter.
- Default ceilings: 12 model turns, 10 MCP reads, 60 seconds, 60-second observation age, 16 KiB per read, and 4,096 output tokens per model call. Limits can be tightened. One retry is permitted for failed reads. Critical proposal validation is still future work.
- Verification: 49 new offline tests plus 34 selected existing regression tests passed (83 total). The paid live evaluation is skipped by default and was run separately against `gemini-3.8-flash`: 1 test passed with synthetic MCP data and zero live wallet/transaction calls.
- The initial live test was blocked by local sandbox permissions; running the same test with existing Google authentication outside that sandbox succeeded. Endpoint access is confirmed for this development environment, not every deployment.
- TypeScript checking (`--noEmit --incremental false`) and targeted lint both passed. Git whitespace checks passed for the tracked changes.
- Phase 2 is now integrated: authenticated investigation endpoint, sealed follow-up context, normalized evidence, batched reads, surfaced goal understanding and the unified copilot surface. Follow-ups continue only when a question is open. The UI retains existing site styling.
- Phase 3 has started with deployed RiskEngine verification and an exact-arithmetic health-path validator. See [verification record](RISK_ENGINE_VERIFICATION.md). Position valuation and sizing remain incomplete; no new proposal is authorized for execution.
- Continuation: raw and Blend receipt valuation now reproduces the captured live contract total exactly at one ledger. Same-asset APR comparisons are connected to the investigation card. A browser check exposed that Run still called only the legacy path; authenticated Flash dispatch now connects the investigator while retaining the existing concrete-action handler. Five live Gemini 3.8 Flash dispatch scenarios passed.
- Phases 4–6 remain planned and are not production-validated.

### Scope and limitations of the first slice

- The copilot composer now calls the investigator through its dedicated authenticated route. Existing transaction endpoints remain separate; research results cannot authorize them.
- `investigateWithFlash` is an internal server entry point. It checks the bound subject; the future caller must resolve and verify wallet/account ownership and network before supplying its scope.
- A valid evidence ID proves an observation exists and is recent; it does **not** prove that a model's prose correctly interprets that observation. Findings and goal understanding are internal drafts. Phase 3 must validate financial claims and Phase 2 must validate goal coverage before user-facing proposals.
- `observedAt` is the read-start timestamp, not the upstream ledger timestamp. Normalization and upstream freshness checks belong to Phase 2–3.
- The runtime stops promptly on cancellation, but the existing MCP transport cannot cancel an already dispatched read. Late results are discarded; no subsequent read starts.
- No global investigation memory is shared between users. Durable task memory and execution state are future phases.
- MCP signatures were checked against local source; production tool/schema reconciliation remains a rollout gate.
- CodeRabbit CLI was unavailable; this slice received manual source inspection and automated local checks, not a CodeRabbit service review.

### Reproduce checks

Offline checks:

```powershell
npx vitest run tests/lib/investigation-runtime.test.ts tests/lib/investigation-flash.test.ts tests/lib/investigation-vertex.test.ts tests/lib/investigation-live.test.ts tests/lib/vertex-auth-mode.test.ts tests/lib/assistant-routing.test.ts tests/lib/plan-approval-summary.test.ts tests/lib/mcp-client-token-refresh.test.ts
npx tsc --noEmit --incremental false
npx eslint lib/copilot/investigation tests/lib/investigation-runtime.test.ts tests/lib/investigation-flash.test.ts tests/lib/investigation-vertex.test.ts tests/lib/investigation-live.test.ts
```

Optional paid provider smoke test (uses existing local Google authentication and synthetic MCP fixtures; run in a dedicated shell so test overrides do not affect development):

```powershell
$env:RUN_FLASH_INVESTIGATION_EVAL='1'
$env:VERTEX_MODEL='gemini-3.8-flash'
npx vitest run tests/lib/investigation-live.test.ts
```

Next development milestone: implement trusted sequential strategy simulation using the verified raw/Blend valuation subset, then deterministic sizing and proposal validation. Resolve LP and borrowed-proceeds transition behavior before supporting those shapes. Do not route research drafts into the existing executor. The initial September 8 continuation corrected the MCP dust-debt bypass with 23 passing RiskEngine tests; subsequent checks cover valuation, comparison, dispatch, cancellation and integration.

### Collateral authority — RESOLVED 2026-09-08 (owner decision)

Phase 3 sizing was blocked on which collateral base is authoritative. **Decision: the
`dev` branch's own computation is authoritative** — it is the fixed version (Rohit's
`8b8d8a4`), and this checkout's `lib/account-snapshot.ts`,
`lib/analytics/stellar/farmTrackingCollateral.ts`, `lib/margin-health.ts` and
`hooks/use-account-snapshot.ts` are byte-identical to `origin/dev`, so the figures measured
here are dev's figures.

The authoritative math, from `lib/margin-health.ts`:

```
health factor      = grossCollateralValue / effectiveDebtValue     (999 sentinel when no debt)
liquidatable when  = HF <= 1.1
debt limit         = grossCollateralValue / 1.1
net available      = grossCollateralValue - effectiveDebtValue
```

`grossCollateralValue` = recorded collateral, plus the live raw-SAC overlay
(`reconcileMarginRawSacCollateral`), plus farm/LP receipts — and **no** debt netting.
Debt is not added to collateral. Independently confirmed: `LIQUIDATION_THRESHOLD = 1.1`
compared with `<=` matches the deployed RiskEngine exactly — `is_account_healthy`
binary-searched to 1e-6 returns false at HF `1.100000` and true at `1.100001`.

**Sizing rule that follows:** size against `grossCollateralValue` with the formula above.
Keep `readContractHealthState` (`lib/copilot/investigation/contract-health.ts`) as a
SECOND, independent gate rather than the primary base — the contract's
`get_current_total_balance` reads lower (measured 3,201.70 vs the app's 4,219.36) because
it uses the stale recorded ledger for SOUSDC and excludes LP receipts. That is a
contract-side accounting gap, not the app being wrong, but a plan the chain's own guard
would reject must still be caught before it is offered. Where the two disagree, offer the
plan only if BOTH clear the floor; report the contract's objection rather than silently
sizing to the looser number. See `docs/copilot/OPEN-ISSUES.md` §Z for the measurements.

### Status as of 2026-09-09

**Phase 1 — done** (Astara's foundation, independently audited: read allowlist, identity
binding, sealed continuation, no write reachable from `resolveRead`).

**Phase 2 — done.** One composer, one Run. Every prompt is investigated and the plan then
builds itself; the investigate/action router has been deleted, so there is no mode for a
user to pick and no classifier that can send a concrete instruction past the reads.

**Phase 3 — deterministic core complete.**
- `valuation.ts` reproduces `get_current_total_balance` exactly from single-ledger reads.
- `contract-health.ts` is the trusted simulator `health-path.ts` required and never had.
- `sizing.ts` sizes legs and solves max-borrow-at-floor in closed form, checking every
  intermediate state, with borrows counted on both sides.
- `capacity.ts` reports headroom at the user's own stated floor, from dev's authoritative
  `grossCollateralValue`.
- `candidates.ts` enumerates and ranks feasible shapes, always offering the non-borrowing
  alternative and REJECTING a negative or break-even carry with its reason.
- `rate-comparison.ts` compares APR to APR only.

**Phase 3 is now wired to the surface.** `tests/components/investigation-card-options.test.tsx`
renders the Options block from `generateCandidates` output and asserts the sizes, the net
carry, the resulting health factor, the DOM ranking, the ruled-out reason, and that a
"do not borrow" prompt shows no borrow shape at all — not even a ruled-out one, which still
reads as a suggestion the user already declined.

`candidates.ts` also honours an amount the user names outright: a stated $500 is sized at
$500 rather than to the floor. This was wrong before — naming an amount produced a
floor-sized proposal, so "borrow 500 USDC" rendered as $6,541. An amount that will not fit
is refused with the figure that would, never quietly reduced; an amount that cannot be
valued from a price read this turn yields no options at all rather than a floor-sized
substitute.

Still open in Phase 3: LP shapes — deliberately absent because the borrow guards skip LP
receipts while the total-balance path prices them, so their collateral value is not
validated.

**Phases 4-6 — in progress, not complete.** The user selected `vanna-mcp` on 2026-09-09.
The dedicated Firestore database `copilot-workflows` now exists in `us-central1` and
passed a live encrypted create/read/concurrent-CAS test. Server-side journal primitives
cover frozen proposal digests, scoped ownership, expiration, one-time approval claims,
step claims, uncertain outcomes and matching settlement. See `WORKFLOW_STORE.md`.
**Phase 4 gaps closed since:**
- `claimNext` now re-checks readiness immediately **before each step is broadcast**, not
  once at approval. Approval is not a standing licence: a price move between leg one and
  leg two can carry the position through the user's floor. A refusal blocks the run rather
  than re-sizing the amount to fit, and a readiness check that throws counts as a refusal.
- A proposal whose amount is still a sentinel or zero is refused (`unsized_proposal_step`).
  Asking someone to approve a step whose real amount is decided later is not consent.
- A configured-but-dead delegated session is no longer labelled active authority.
  `enabled: true` alongside `session_expired` / `no_active_session` / `over_daily_cap` /
  `unauthorized` renders "Not usable (…)" with a warning that every transaction still needs
  the user's wallet.

**Phase 5 gap closed since:** `reconcile` resolves an uncertain submission by asking the
ledger about the recorded reference — settling it, stopping the run if it failed, or
freeing it for a genuine retry only once the ledger shows nothing was spent. With no
reference it refuses rather than guessing which recent transaction was ours, so
"reconcile before retrying" is enforced rather than advised.

**Phase 6 —** [EVALUATION.md](./EVALUATION.md) audits all ten required scenarios against
the tests that actually assert them, and names the four honest gaps: no held-out paraphrase
corpus, no bounded downstream sizing, no browser-refresh resume, and no cost/latency
instrumentation. Read-only deployment is retired as a scenario: the gate was removed at the
owner's instruction.

**The one caveat that matters most:** the journal is a verified library that **no route
calls yet**. It is referenced by nothing under `app/`, so the live surface still runs the
pre-existing write path and these guarantees protect the journal, not yet the button the
owner clicks. Remaining work: proposal compilation from a candidate, the approval and
signing endpoints, and browser wiring.

**Durability is blocked on a permission grant, not on code.** The request to give
`vanna-app-run@vanna-main.iam.gserviceaccount.com` read/write on the `copilot-workflows`
database was rejected by automatic approval review; no access was granted and none was
retried. `workflowStore()` throws in production when unconfigured rather than falling back
to a process-local map that would lose approvals on restart.

Audit corrections: the investigation no longer replays the raw user prompt through
the legacy executor automatically. Per-asset idle funds replace combined-wallet funds
when sizing alternatives; forbidding borrowing does not suppress supply comparisons.
The health snapshot lookup overlaps investigation instead of running after it. Normal
balance answers now render as grounded sentences beside the understanding and evidence.

**Timeout budgets are now ordered and test-enforced** (`investigation-timeout-budget.test.ts`):
runtime 55s + scope 20s <= route 75s < client 120s. Batched reads run concurrently.
Measured investigate durations after that change: 27s / 38s / 66s.

### Session 2026-09-09 (later) — three live bugs found by running it

1. **Zero-output investigations.** A turn reported "0 reads" after 67s. Two compounding
   causes in `runtime.ts`: reads inherited only the 55s RUN deadline, so one stalled MCP
   call held the whole concurrent batch (the app's own `/api/analytics/accounts` was taking
   100s+ against the same RPC, with repeated `ECONNRESET` from BlendService); and the batch
   was recorded only AFTER the deadline check, so every read that had completed was
   discarded. Fixed: `maxReadDurationMs: 15_000` per read, and the batch is recorded before
   the stop is reported. Cancellation still discards, deliberately — the client is gone.
   Verified live: the same account question now returns 5 reads.

2. **"Health factor unavailable" beside a rail showing 2.43.** MCP's `account_health`
   returned debt positions but no scalar ratio. The authoritative snapshot is now read
   BEFORE the loop and handed to the model as seed evidence (`InvestigationRequest.seed`),
   which also removes three reads and a turn or two from every account question — most of
   why one health question took half a minute.

3. **The surface was a dead end.** `dispatchRun` only investigated; the bridge to execution
   had been removed in favour of proposal routes that are built but not exposed, and
   `InvestigationCard` shows a Continue button only when given `onContinue`, which it was
   not. So an actionable prompt investigated and then nothing happened — no plan, no answer,
   no button. Restored as an effect that acts once per sealed continuation, and ONLY on
   `status: "researched"` with no open question. Interim by nature: it hands the prompt to
   the existing executor, which re-derives its own steps instead of executing the sized
   candidate. The proper fix is the journal's proposal routes.

Also: `hi` ran the full loop — scope resolution, several model turns, five reads — to answer
a greeting. `investigation/immediate.ts` now answers greetings and capability questions
directly, and refuses off-domain prompts with the domain firewall's own message, before any
model call or read. This is NOT the removed investigate/action router: it decides only
whether the message is a financial request at all, and anything that could be one falls
through untouched.
