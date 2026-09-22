# Handoff — model proposes, code disposes (13 Sep 2026)

**For any agent.** Branch `feat/copilot-finetune` in `mercury-stellar-backend`, from Aditya's
`copilot-upgrade` @ `f7413d7`. Companion MCP change in `vanna_mcp` (`wallet_tools.py`).
**Baseline at handoff:** `tsc` clean · vitest **1779 / 0 / 3** · MCP pytest **561** (PR #4) ·
eslint 0 errors (one pre-existing warning, one pre-existing React-19 effect error in
`investigation-card.tsx:86`, both Aditya's code). §7 covers the afternoon's live loop.

Read `SESSION-HANDOFF.md` §0 and §0a first — the working rules still apply. This document
covers one pass: the generalize-not-enumerate handoff §1–§5 done, and the architecture change
its §0 implied but did not name.

**Honest opening.** The first signed-in battery said the copilot was "enumerated rather than
intelligent". It was — but not because the model was weak. The model was only ever allowed to
understand and fetch; the strategy came from three hand-written shapes, the facts from a
14-case switch, the rate table from four literals, the floor from a regex list. Every real
prompt outside those lists produced an empty card. This pass moved the recipe to the model and
kept arithmetic and authority in code. Six live prompts from the owner's own words drove it;
each one found a defect, each defect is pinned by a test. **Execution is still blocked at one
spot** (§5) and it is not a copilot bug.

---

## 1. What changed — by defect, with the acceptance test

| Handoff item | Defect seen live | Fix | Pinned by |
|---|---|---|---|
| §1 ids | every option button 400 | `candidate-id.ts` mints, parses, validates; route has no regex | `candidate-id.test.ts` — `future_kind:US-DC2` passes the real route |
| §2 normalizer | `farm_overview`, `collateral_config`, `max_borrow` read OK, reported unavailable; `USDC: not_resolvable` read as failure | `facts-by-shape.ts` derives facts from `*_pct/_usd/_human` conventions; `normalize.ts` keeps five judgement branches only | `facts-by-shape.test.ts` — a capability with no branch renders |
| rate cap | Blend XLM 168.6% APR silently dropped (>100% cap); zero options | plausibility = `supply ≤ borrow × utilization`; exclusions named on the card | `investigation-rate-comparison.test.ts` |
| **strategy space** | "deploy XLM+USDC in farm" → nothing | model returns `plans` (legs + sizing WORDS); `plan.ts` sizes, projects HF per leg, allowlists, ranks | `plan-resolve.test.ts`, `investigation-plans-e2e.test.ts` |
| floor | regex missed "stays above 1.3" → all borrows refused; 1.1 → "position not read"; "avoid liquidation" invented 1.3 | model reports `healthFactorFloor` anchored to the user's quote; sizer takes `null` = contract line; borrow needs a floor, deposit never does | `floor-anchored.test.ts`, `sizing-no-floor.test.ts` |
| reads | market seed gated on a phrase list → "no XLM price was read" | `readsForPlans` derives the reads from the legs; code fetches before sizing | `strategy-reads-for-plans.test.ts` |
| carry | "+-31.56% net APR" offered | negative carry ruled out with the rates; sign fixed | `plan-resolve.test.ts` |
| shortfall | "no headroom" dead end | "add $X collateral (≈ N XLM) or repay $Y" from the closed form (Gap H) | `plan-resolve.test.ts` |
| executor | simulation rejection shown as "could not be confirmed" | MCP envelope with `reason/code/contract_diagnostic` = pre-broadcast → `failed` with its message | `floor-anchored.test.ts` (`preBroadcastRejection`) |
| basis | plans sized from the app snapshot, bypassing the contract reconciliation | `computeSizingBasis`: contract figures once the app agrees; disagreement carried as data — deposit sizes, borrow refused with both numbers | e2e "sources disagree" case |
| propose | 409 on stale evidence; then a 90s timeout (two unbounded snapshot reads) | sealed floor + one bounded snapshot + one basis | e2e "stale bundle" case |
| card | no in-flight state; buttons dead after a rejection; chip duplicated | progress line; buttons live unless a plan is in flight/uncertain | `investigation-card-options.test.tsx` |
| hardcoding | op vocabulary in 10 places, assets in 5, `"1.30"` in 2 | `WORKFLOW_OPS` one source; registry/observations for assets; no default floor | grep of `investigation/` for asset alternations returns nothing |
| MCP | `fee_reserve_xlm: 0.5` ignores the chain minimum balance → HostError #10 on "all idle" | `spendable` = balance − (2+subentries+sponsoring−sponsored)×base reserve − fee, from Horizon; app prefers it, falls back | `test_mcp_wallet_tools.py` |

## 2. The contract (what the model may say)

`research_complete` may now carry `plans: [{ title, rationale, evidenceIds, legs: [{ op, asset, sizing }] }]`
with `op ∈ WORKFLOW_OPS` and `sizing ∈ { all_idle, to_floor, previous_leg, literal{amount, sourceQuote} }`,
and `goal.healthFactorFloor: { value, sourceQuote }`. Every number the user sees is code's:
literal amounts and floors are accepted only when their quote is in the user's message. A
malformed plan drops that plan and says so; it never voids the research.

## 3. Decisions — do not re-litigate

- **Floor:** the user's number or the contract's line. No default, ever. `null` floor = "may
  not pass through a liquidatable state"; a max borrow needs a stated floor.
- **Basis:** sizing uses the liquidation engine's figures, and only when the Margin page agrees
  within drift. On disagreement a deposit still sizes (its amount is the wallet's) projected on
  the engine's figures; anything that lowers health is refused with both numbers.
- **Borrow permission:** unspecified offers a levered path beside the idle one; only an explicit
  prohibition removes it (owner rule in `service.ts`).
- **Composed vs fixed:** the same op sequence reached both ways is one option; the composed
  copy wins because it carries the rationale. Fixed shapes remain as a floor under the model.
- **Literal + sizing in one request** is one plan with a literal leg — `goal.actions` is for
  literal-only requests.

## 4. Where I was wrong today (so the next agent is not)

- I first sized plans from the **app snapshot**. That bypassed the contract reconciliation and
  showed a $17k borrow the engine would not have allowed. Caught by the 409 it later caused.
- I first required `borrowing ∈ {allowed, required}` for a plan borrow. The owner rule is
  "unspecified offers both".
- I first read the app snapshot **twice** on propose, unbounded — a 90s client timeout.
- I first let a plan with **no floor** be sized against a 1.1 default via `sizeLegs`. A deposit
  needs no floor at all.

## 5. Open — in the order that unblocks the most

1. **Deploy the MCP** (`spendable`). Until then every "deposit all idle XLM" is rejected at
   simulation. Aditya's rules: verify first, commit and tag what ships.
2. **Collateral disagreement on the test account:** ~883 XLM inside `CCKIT…DMC` unposted.
   Margin page $6,594.61 vs engine $6,435.97 (debt agrees). No MCP op posts account-held
   tokens. App/protocol question; until resolved no borrow is sized on this account — correctly.
3. **Vocabulary:** `redeem` and `withdraw_collateral` landed (`681ad90`) with the sizing word
   `all_position`; the Sign Service already allowlists `redeem_vtokens`, `withdraw_collateral`,
   `deposit_borrow_and_deploy_blend` and `execute`. Remaining and mechanical: `blend_withdraw`,
   `swap` (value the output at oracle less slippage), `deploy_to_blend` (one tx for
   deposit+borrow+supply). `add_liquidity`/`remove_liquidity` wait on the risk engine valuing
   LP receipts — owner decision recorded in `candidates.ts`. Not yet live-tested: the
   redeem → deposit path; first prompt to try is the owner's "use my AqUSDC in Earn as collateral".
4. **Runway on the card:** time to the liquidation line at today's borrow rate, derived. Small.
5. **Three-turn refinement**, and the battery in `PROMPT-LIBRARY.md` with the owner's words.
6. Pre-existing and untouched: `evidence.ts` capability whitelist (a size bound), the asset
   registry as static app knowledge, `needsMarketSeed` (now only a pre-seed optimisation), the
   `MIN_HEALTH_FACTOR=1.3` guardian default (app-side).

## 6. The afternoon: live loop, then local MCP loop

Every prompt below is in `PROMPT-LIBRARY.md` with the card text verbatim.

| Prompt (owner's words) | Seen live | Fix | Commit |
|---|---|---|---|
| "use my AqUSDC sitting in Earn as collateral" | both txs settled while the card said "Broadcasting…" — the hook asked once, before the ledger closed, then waited for a click | a submitted step is re-asked about at every ledger close (`useLedgerTick`); run continues by itself | `f7c3218` |
| "Deposit 10000 XLM … deploy it in the Blend farm" | executed, but the composed plan was refused (`sized: 0`) for a literal on `supply_blend`; the literal-only path caught it without rationale | a literal Blend supply is accepted when the deposit/borrow before it put in at least that much | `1557a3b` |
| "put my XLM and USDC into the Aquarius XLM/USDC LP" | "invalid decision" — the limitation finding had no evidence id | an uncited finding is kept when it states no figure; an uncited figure is dropped and counted (`droppedFindings`) | `ebb47e5` |
| same | "No Aquarius pool … available" — MCP read false; card showed it as "one choice … answer below" | venues, venue→USDC and LP pairings printed from the registry (`lpVenue`, checked against `chain-facts.json`); named venue fixes the USDC, open venue with several executable fits is asked, non-executable venue is a limitation; open questions render as "unresolved" | `00068f3`, `d700d02` |
| prompt text | "(redeeming from Earn, withdrawing collateral, LP, swaps)" still listed as unsupported | stale examples removed; the list derives from `PLAN_OPS_TEXT` | `126292d` |

**Owner rule recorded (13 Sep):** "deposit USDC into farm Blend" resolves itself (Blend takes
BLUSDC); "deposit USDC into farm" with several executable farm venues asks which — today Blend
is the only executable farm venue, so it resolves and says so; the question appears by itself
once LP ops join `WORKFLOW_OPS`. Which USDC is never asked. This replaced Aditya's "venue
selection is yours, by read rate" line in `flash.ts`.

**MCP side — the local-first rule.** A PR to `vanna_mcp` counts only when the failure was
seen on the hosted MCP and the fix was reproduced through the copilot against the MCP running
locally. PR #3 (`spendable`) and PR #4 (Aquarius pool via the router, by token contract, at
the fee tier `add_liquidity` uses — the hosted read scanned page 1 by code) both passed that
bar on 13 Sep: the farm prompt deposited 202.496924 XLM (= balance − 3.5 minimum − 0.5 fee)
and settled; the LP prompt named the pool and refused correctly. The local loop itself
(streamable-http MCP with the deployed OAUTH_* settings, a local Sign Service because the
hosted one is IAM-restricted, a cached identity-token failure that otherwise costs 12 s per
call) lives on `vanna_mcp` branch `local/mcp-integration`, not in a PR — owner decision.

**Not done, noted:** the rates sentence can print the same Blend rate twice; the "Aquarius
pools were discovered; executable quotes…" warning is noise on a refused LP prompt.

## 8. 14 Sep — why it kept looking "dumb", and what closes the class (say this to the team)

**The pipeline in one line: the model proposes, the code disposes, the protocol decides.**

| Stage | Who | Job | May invent |
|---|---|---|---|
| Propose | Gemini | read the user's words and the facts we fetched; say *what* to do in a fixed vocabulary — 7 ops × 6 sizing words | the shape only, never a number |
| Dispose | `plan.ts` | turn the shape into amounts from live reads, project HF, allowlist, rank — or refuse with a sentence that names a figure | nothing |
| Decide | MCP → contract | build, simulate, sign, submit | nothing |

So "is Gemini dumb?" is the wrong question. Every defect of 12–14 Sep was in stage 2's inputs or
rules. Five classes, and every bug we fixed is one of them:

1. **Facts hidden from the model** — the debt said `USDC`, the registry knew that is `BLUSDC`
   at the margin venue, the model never saw it and guessed `AQUSDC`. Fixed once, at the funnel.
2. **Rules narrower than language** — "25 % of my XLM" had no sizing word. `fraction` added.
3. **Protocol semantics not encoded** — `vanna_repay` draws from the smart account, so a one-leg
   repay from the wallet could never run. Expansion deposit → repay.
4. **Wrong derivations** — oracle `decimals` used as token precision → a 14-place XLM amount.
5. **Ordering / second paths** — the plan's own read stamped "in the future"; a *stated* write
   ("lend 1 xlm") taking a shortcut that never read a balance.

**Why it was not bulletproof.** We found these one prompt at a time; each prompt is one cell of
op × sizing × asset × funding state — ~50,000 cells — and we had typed ~40. And a plan that
passes stage 2 could still fail at stage 3, which the user only learned on Approve.

**What closed it (all on `feat/copilot-finetune`):**

- **The op-flow table** (`workflow/types.ts` `OP_FLOW`, `728dba4`): for each op, where the
  tokens come from, where they land, which read caps it, how it moves health, which rate labels
  it. The sizer, the reads a plan needs, the risk validator's funds flow, the prompt's venue list
  and the simulation all derive from it. It immediately exposed a real disagreement — the
  validator charged a Blend supply as a full withdrawal while the sizer called it neutral; the
  contract source (`RiskEngineContract`, `BlendUnderlying`) says neutral. One truth now.
- **The shape matrix** (`tests/lib/plan-shape-matrix.test.ts`, `728dba4`): every cell generated
  from `WORKFLOW_OPS` × `PLAN_SIZINGS` × `ASSET_IDS` × funding states, one invariant each. A new
  op, word or asset grows the grid by itself. First run: "lend 100 XLM" offered from an empty
  wallet — nothing had ever checked a stated amount against a balance.
- **Stated writes through the sizer** (`f58897b`): the shortcut is gone; "lend 1 xlm" is a plan
  of literal legs and gets the same reads, funding, precision and refusal as everything else.
- **Propose-time simulation** (`investigation/simulate.ts`, `f58897b`): before a card is shown
  and again at Prepare, each step the chain can be asked about goes to the MCP `preview`
  (RiskEngine snapshot + `is_borrow_allowed` / `is_withdraw_allowed` + pool ceiling + Earn
  minimum). The protocol's "no" removes the option with its own sentence. A step that follows
  from an earlier one is projected, not simulated, and the card says so. An older server, a
  timeout or a failed call never blocks — silence is not a yes.

**Limits to say out loud.** The preview answers against the *current* chain state, so only the
first independent step of a composed plan is truly simulated; the rest stand on the sizer's
projection (labelled). The hosted MCP does not yet report `spendable`/`min_balance` (PR #3), so the
3.94-XLM wallet is still offered there until PR #3 deploys. Blend supply has no preview.

## 7. Files

New: `lib/copilot/investigation/{candidate-id,facts-by-shape,floor,plan,simulate}.ts`; `tests/lib/{plan-shape-matrix,workflow-op-flow,investigation-simulate}.test.ts`.
Removed (14 Sep): `investigation/requested-actions.ts` — stated writes are plans now.
Changed: `investigation/{answer,candidates,capacity,compile,decision,decls,evidence,execute,flash,normalize,proposal,rate-comparison,read-cache,service,sizing,strategy-reads,types}.ts`,
`workflow/{allowlist,risk,types}.ts`, `router.ts`, `app/api/copilot/workflow/propose/route.ts`,
`components/copilot/investigation-card.tsx`. MCP: `mcp_server/tools/wallet_tools.py`.
Diagrams: `vanna_mcp/docs/COPILOT_MCP_FLOW_DIAGRAMS.md` §7 (drop points) and §8 (this design).
