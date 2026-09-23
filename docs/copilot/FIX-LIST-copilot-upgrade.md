# Copilot fix list — for the merge into `copilot-upgrade`, then `dev`

Opened 22 Sep 2026. Branch `fix/copilot-catalogue-architectural-fixes`, forked from
`d923b0e` (`dev` and `copilot-upgrade` are the same commit at that point).

Nothing here is merged. Do not merge until the catalogue has been run end to end.

---

## Done — fixed and verified

### 1. A stated HF floor swallowed the whole prompt
`Deploy XLM into farm to maximize returns while maintaining health factor above 1.4.`
routed to a bare account-health read. The "deploy into farm" clause was discarded.

`router.ts` has two health branches. The one at ~L2500 gates on `!hasActionWriteIntent`
**and** `!isStrategyOrBuildIntent`. The floor branch at ~L3063 was written with only the
second half, so any sentence containing a floor and an action was claimed as a read.
`hasActionWriteIntent` already contained `deploy` and `farm` and was already in scope.

**Fix:** the floor branch now consults `hasActionWriteIntent`, matching its sibling.
No verb was added to any list.

### 2. A stated floor was dropped from the intent entirely
`deploy my idle funds into blend keeping HF above 1.4` routed to:

```
op: "deploy_to_blend", fraction: 1, requires_amount: false     ← no min_hf field at all
```

`fraction: 1` is *all of it*, every sizing gate is satisfied, so it went direct and
committed the whole idle balance with the floor gone. `tests/lib/copilot-entry-lane.test.ts`
already asserted this prompt must reach investigation, **and that test was failing on the
shipped `dev` branch**.

**Fix:** `entry-lane.ts` — a prompt that states an HF floor *and* asks for an action goes
to investigation. A floor is a property of the account after the legs run, so honouring it
needs sizing against live state, which only investigation does. This matches the lane table
in the Test Prompt Catalogue §2 ("keep my health factor above … → Strategy (sizing)").
None of the 14 `direct` rows in the test file state a floor.

**Verified:** 519 tests across every file touching `entry-lane`/`routeMessage`: one
previously-red test now passes, nothing broken. Confirmed against the live MCP on
localhost — `/api/copilot` now returns `investigation_owns_planning`, and the investigation
loop builds two real candidates (*Leveraged XLM Blend Farm (HF ≥ 1.4)* and *Unleveraged
XLM Blend Farm*).

---

## Open — diagnosed, not yet fixed

_(item 3 moved to Done on 22 Sep — see below)_

### 3. [FIXED] Two execution cards for one run, and the stale one sits on top
Prompt: `deposit 100 XLM as collateral and borrow 20 BLUSDC`. Observed 22 Sep, auto-approve
OFF, Privy wallet. Both legs settled on-chain correctly — this is presentation only.

Both `ExecutionStepper` render sites in `copilot-workspace.tsx` (~L5500 and ~L5758) build a
**hardcoded one-element array**, `steps={[{ id: "direct-tx", … }]}`, from the single current
`action`. So on a two-leg direct run the stepper can only ever draw one leg. Meanwhile
`run-execution-card.tsx` draws the real run ("02 · EXECUTING · 1 of 2 settled").

Three reported symptoms, one cause:
- **Both cards appear** — the suppression guard at ~L5496 is
  `txHash && !investigation.turns.some(t => t.executionReceipt)`. Receipts are built from
  `workflow.view`, which only the investigation/workflow path produces. The direct multi-leg
  path makes no receipt, so the guard never fires.
- **The wrong card is on top** — the stepper renders immediately after `<ChatTurns>` and
  before the run card, so it is always above regardless of when it happened.
- **The final card is missing the borrow leg** — it is the one-element array, frozen at
  leg 1, while the headline text updated to "Borrow 20 BLUSDC — settled on-chain".

`investigation-card.tsx` ~L112 already documents this exact bug shape for the swap path and
fixes it there with `stepperDrawnInThread`. The direct multi-leg path is a separate code
path and did not get it — the usual three-write-paths trap.

**Fixed 22 Sep.** The cause was upstream of the cards. Every settled leg wrote an execution
receipt whose `steps` array was built from `action` — the single write just signed — so leg 2
overwrote leg 1 with another one-element array. It was also keyed by `response.request_id`,
which is per REQUEST while a multi-leg run is many requests, so each leg wrote under a new key,
failed to find the turn the previous leg had written, and fell through to "first assistant turn
with no receipt".

The receipt now describes the run: legs come from `strategyStepsRef`, gated by
`isRealStrategyRun` — the same predicate the run card itself is gated on — under one id per run
(`runReceiptIdRef`). No card needed a special case, and no op name is tested anywhere.

This fixes all three symptoms at once, because the existing suppression guard
(`!turns.some(t => t.executionReceipt)`) starts working once the receipt actually matches its
turn: the stepper stops drawing, so the duplicate and the wrong ordering both go, and the
finished card carries every leg.

**Verified:** typecheck clean; 62 tests across every receipt/stepper/run-card file pass.
**Not yet verified in the browser** — needs a live two-leg run to confirm.

### 4. `TrustlineMissingError` on BLUSDC borrow — preflight cannot see it
`SAC transfer failed (HostError #13 TrustlineMissingError)`.

This is a genuine on-chain Stellar error and the app reported it correctly and safely —
nothing was broadcast. It is **not** an LTV or health failure and not a copilot logic bug.
The destination (pool vault or the receiving account) has no authorised BLUSDC trustline, or
its limit is too low.

The real gap is a preflight gap, and it is **MCP-side, not app-side**: `vanna_can_borrow` and
the on-chain `is_borrow_allowed` check health and pool liquidity only. Neither creates nor
verifies a trustline, so preflight says yes and the ledger says no. Fix belongs in
`vanna_mcp` — add a trustline check to the borrow preflight so this refuses before it is
built, with a sentence naming the missing trustline.

### 5. Auto-approve ON not detected; asks to approve again
Reported by Sanu. Not yet reproduced here. Needs a run with the exact wallet type recorded —
Privy and Freighter arm auto-sign differently (Freighter has no Sign Service session and
needs a SEP-53 session with an extra signer). Capture whether the Autonomy chip reads ON at
the moment the write is built, not just before the prompt.

### 6. Contract errors on strategy / multi-leg
Reported by Sanu, no specific prompt captured yet. Catalogue §8 already documents a likely
contributor: amounts are frozen at sizing time for nine of the eleven operations, and five of
those drift on their own as interest accrues (`repay`, `blend_withdraw`, `redeem`,
`withdraw_collateral`, `borrow`). Log the prompt and the exact error next time rather than
raising it new.

---

## The idle question — recommendation: keep it, fix what it says

Idle is not a stray heuristic; it is the no-new-debt option, and it is ranked first on
purpose. `candidates.ts` L245-250:

```
const idle   = feasible.filter(c => !c.borrows).sort(byExpectedReturn);
const borrow = feasible.filter(c =>  c.borrows).sort(byNetThenSize);
const ranked = [...idle, ...borrow];
```

The catalogue requires exactly this — ES3 "non-borrowing option offered first", XS1
"non-borrowing option ranked first", XS6 "borrow shapes must be suppressed". Removing idle
would make every strategy answer open with *borrow*, which is the opposite of the spec and
the wrong default for a leveraged product.

The actual complaint is sound and is a different bug: **Copilot never tells you that you
have idle assets, or that you have none.** When idle is zero the idle shapes are silently
infeasible and only the borrow shape survives — which is why one account got a leveraged
plan and another got "how much?". The user sees a leveraged proposal with no explanation of
why the safe option vanished.

So: do not remove the ranking. Make the absence legible — state the idle balance per asset
when a shape is offered, and say plainly when a no-borrow option could not be built because
nothing is idle. That is a reporting fix in the answer layer, not a ranking change.

---

## Merge order when this is ready

1. Run the whole Test Prompt Catalogue twice — auto-approve OFF, then ON.
2. `fix/copilot-catalogue-architectural-fixes` → `copilot-upgrade`.
3. Re-check `dev` has not moved; it was equal to `copilot-upgrade` at `d923b0e`.
4. `copilot-upgrade` → `dev`.

---

# 22 Sep, later — catalogue run X3→XS8, and the root cause behind all of it

## The architectural regression that explains the whole class

Before **20 Sep, commit `9c197cd`** ("fix(copilot): route actions and preserve Blend
positions"), `hooks/use-copilot-entry.ts` carried this, and the behaviour to match:

> One composer. EVERY prompt is investigated first, then acted on. This used to ask the
> server to pick one handler — investigate XOR action — which meant a concrete instruction
> skipped investigation entirely and executed against whatever the keyword path inferred,
> while a strategy request could never reach the executor. Both halves were wrong:
> understanding the account is what makes an action safe, so a write should be the
> CONSEQUENCE of an investigation, not an alternative to one.

That commit deleted those words and reinstated the investigate-XOR-action split they warn
about, introducing `classifyCopilotEntry`. It fixed something real — strategy requests could
not previously reach the executor — but every defect in this document is the failure mode
that comment predicted: *a concrete instruction skips investigation and executes against
whatever the keyword path inferred.*

**Recommendation (owner's call, not actioned):** stop repairing the keyword path prompt by
prompt and restore "investigate first, then act". Each fix below is a patch on a path that is
structurally required to guess.

## Catalogue lane results, X3 → XS8

19 of 20 rows reach the lane §2 specifies. One fails:

- **XS8** `what is the best way to double my BLUSDC exposure` → lane **direct**, routed to a
  READ (`query_all_positions`). The catalogue expects Strategy: "leverage framed as a goal —
  should surface the borrow shape with its carry, not just act." Same shape as the HF-floor
  bug already fixed: a read branch claims a prompt whose content is a strategy question.

## Two-leg rows collapse to one leg in the deterministic router

`routeMessage` returns a SINGLE write for five two-leg rows, with the other leg absent from
the intent entirely:

| Row | Prompt | Routed to | Leg lost |
|---|---|---|---|
| X3 | redeem 20 AQUSDC from earn **and deposit it as collateral** | `deposit_collateral` | the redeem — the FUNDING leg |
| X6 | withdraw 30 XLM from blend **and lend it in earn** | `withdraw_from_blend` | the lend |
| X7 | remove my XLM/SOUSDC liquidity **and repay my BLUSDC debt** | `remove_liquidity` | the repay |
| X8 | withdraw 20 XLM collateral **and lend it in earn** | `withdraw_collateral` | the lend |
| X9 | repay 10 BLUSDC **then withdraw 20 XLM collateral** | `repay` | the withdraw |

X3 is the worst shape: it drops the leg that provides the funds and keeps the one that spends
them. NOTE: on the copilot surface the LLM planner, not `routeMessage`, builds the executed
plan — live, X3 did produce both legs. So this is a latent router defect, confirmed for
routing, not yet confirmed to reach execution on every path.

## "deposit **it** as collateral" becomes XLM — an asset the user never named

Live 22 Sep and reproduced locally with no wallet (`template_id: extracted_multi_goal`):
leg 2 came back as **"Deposit XLM as collateral"** for a prompt whose only asset was AQUSDC.

`lib/copilot/step-extractor.ts:475` — `asset: first?.asset || "XLM"`. The clause "deposit it
as collateral" names no asset, so `first` is null and a **hardcoded XLM** is substituted.
Four sites in that file do this (L431, L453, L475, L540), so fixing one is not the fix.

**Fix direction:** an unstated asset in a chained clause is the referent of "it" — the asset
the PREVIOUS leg produces. The fallback belongs at clause assembly (the loop at ~L872, which
already walks clauses in order and can carry the previous step's asset), not as a constant in
each branch. Only a first leg with no antecedent should ever reach a default.

Interestingly the deterministic router gets the asset RIGHT here (`asset: "AQUSDC"`) while
dropping the redeem leg; the planner keeps both legs and gets the asset wrong. Two paths,
two different failures, same prompt.

## MCP trustline — NOT reproducible as described; do not patch blind

Investigated in `vanna_mcp`. Findings:

- There is no trustline pre-flight anywhere. `vanna_can_borrow` checks the risk engine and
  pool liquidity only. The only trustline code is the post-hoc classifier at
  `mcp_server/error_handling.py:268` that produced the message Sanu pasted.
- **But the premise does not hold for the reported case.** The test wallet
  `GDW3B2…VJ52` DOES hold the BLUSDC trustline — Horizon shows `USDC` issued by
  `GATALTGT…` (the Blend issuer, same as BLND), limit 9.2e11, balance 680. BLUSDC is `USDC`
  on the wire per `lib/copilot/registry/assets.ts`.
- A BLUSDC borrow for that same wallet **settled on-chain afterwards** (`tx 4934cebd…`).

So the missing trustline was not on the borrower. It would have to be on a protocol-side
destination (pool vault), which a client pre-flight cannot assume the address of. Writing one
now means guessing which account to check, and a wrong guess produces FALSE REFUSALS that
block valid borrows in production.

**Blocked pending:** the exact prompt, asset, wallet and timestamp of Sanu's failure. With
that, the destination is identifiable from the failed transaction and a correct pre-flight is
straightforward. Nothing was pushed to `vanna_mcp`.

---

## BLOCKER for investigate-first: the workflow store has no database

`POST /api/copilot/workflow/propose` returns **409** for every plan. Not a conflict, and not
the expired Google credential it first looked like — re-authing ADC did not change it.

Verified 22 Sep by calling Firestore directly with a valid token:

```
GET .../projects/vanna-mcp/databases/(default)/documents/copilot_workflows  -> HTTP 404
"The database (default) does not exist for project vanna-mcp"
```

The chain, all confirmed in code:

1. `durableStore` (`lib/copilot/workflow/store.ts:137`) picks Firestore whenever a project is
   named, and falls back to **`GOOGLE_CLOUD_PROJECT`** — which is Vertex's project,
   `vanna-mcp`. `COPILOT_WORKFLOW_FIRESTORE_PROJECT` is not set in `.env.local`.
2. That project has no Firestore database, so every request 404s.
3. `store.write()` — 404 is not 409/412/400, so it falls to
   `throw new Error("workflow_store_http_404")`.
4. `journal.create` throws; it is not a `WorkflowConflict`, so `proposal.ts:279` re-throws.
5. The route catches it and returns **409 `proposal_unavailable`** with a logged stack.

### CORRECTION — this is a regression, not a path that never worked

An earlier draft of this section claimed the workflow path had never worked. That was wrong,
and Aditya was right to push back. `.local/copilot-workflows` holds **193 records**, the last
written **20 Sep 11:35** — investigation proposed and executed fine, against local files.

`git show 3e0587d^:lib/copilot/workflow/store.ts` shows what changed:

```js
// BEFORE
const project = process.env.COPILOT_WORKFLOW_FIRESTORE_PROJECT;   // only this

// AFTER (3e0587d, "conversation history is durable in prod, on the journal's own store")
const project =
  process.env.COPILOT_WORKFLOW_FIRESTORE_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||     // <- added, and set in every local .env.local for Vertex
  process.env.GCLOUD_PROJECT;
```

The commit widened the lookup so CONVERSATIONS would be durable in production without new
configuration. The side effect: the WORKFLOW store in local development stopped using files
and began calling a Firestore database in Vertex's project, which has never existed. The
records stop on the day it landed.

There is a SECOND half to this, found 23 Sep after Aditya created a `(default)` database.
`vanna-mcp` already had a NAMED database, `copilot-workflows`, holding 3 workflow docs and 3
conversation docs — so PRODUCTION has been writing successfully all along. `.env.example:8`
documents `COPILOT_WORKFLOW_FIRESTORE_DATABASE=copilot-workflows`; the deployment sets it,
and `.env.local` does not. So local fell back to the code default `"(default)"`, which did not
exist until 23 Sep.

So the local break needed BOTH: 3e0587d supplying a project from Vertex, and the missing
database variable sending it to a database nobody had created.

**Fixed 23 Sep:** `durableStore` only inherits `GOOGLE_CLOUD_PROJECT` when actually running deployed
(`NODE_ENV=production` or `K_SERVICE`). Development goes back to local files unless
`COPILOT_WORKFLOW_FIRESTORE_PROJECT` explicitly asks for Firestore. Deployed behaviour is
unchanged.

### Not a shipping blocker after all
Production already works — it names the `copilot-workflows` database explicitly and has records
there. Investigate-first does not need new infrastructure to ship.

Two housekeeping notes:
- The `(default)` database created on 23 Sep is empty and is NOT the store in use. Check nothing
  else claims it before deleting it, and do not point the app at it.
- Local now uses files (the fix above). To make local mirror production exactly instead, add
  `COPILOT_WORKFLOW_FIRESTORE_DATABASE=copilot-workflows` to `.env.local` — at the cost of writing
  development runs into the shared store.

### Two code defects worth fixing regardless of the lane decision

- **A missing database is invisible on reads.** `store.read()` treats 404 as "no record"
  (`if (response.status === 404) return null`). A database that does not exist is
  indistinguishable from an empty one, so the misconfiguration stays silent until the first
  write and then surfaces as a "conflict".
- **The workflow store inherits Vertex's project.** "One project configures them all" holds
  only if that project has Firestore. Naming Vertex's project as the fallback for a durable
  store couples two unrelated deployment decisions.

---

## `lend me 50xlm` becomes a BORROW — investigate-first drops an existing guard

Found 23 Sep on `try/investigate-first`, auto-approve ON, one click from executing.

| Prompt | Understood as | `borrowing` |
|---|---|---|
| `lend me 50xlm` | **"Borrow 50 XLM."** | **required** |
| `lend 50 XLM` | "Lend 50 XLM into Vanna Earn." | forbidden |
| `lend me 50 XLM into earn` | "Lend 50 XLM into Vanna Earn" | unspecified |

The word **"me"** inverts the action. Supplying capital becomes taking on debt.

The model is not being stupid — "lend me X" idiomatically means "loan me X", where the
speaker RECEIVES. That reading is defensible English. It is the wrong reading of a product
whose Earn surface is called Lend, and the two readings are opposite financial actions, so
this is a case to ASK about, never to pick silently.

It compounds: `borrowing: "required"` makes `rankFeasible` return borrow shapes ONLY
(`candidates.ts:249`). A misread verb does not merely add a wrong option, it deletes the safe
one — the non-borrowing shape is never offered.

### This is a regression from the experiment, not a pre-existing bug
`routeMessage("lend me 50xlm")` returns `op: lend`. The keyword lane gets it right.

### The guard already exists and is wired to the wrong path
`lib/copilot/leg-direction.ts` was written for exactly this class — its docstring cites
"withdraw 30 XLM from blend and lend it in earn" planning money INTO Blend, "one signature
from executing." Its principle:

> Direction is already stated once, as data, in `OP_FLOW`'s `from`/`to` pockets. This reads
> it rather than teaching a planner which verbs mean "out" — a verb-to-op table is how the
> two got to disagree in the first place.

`OP_FLOW` states the contradiction as data:

```
lend:   from wallet → to earn     health: neutral
borrow: from debt   → to account  health: lowers
```

`leg-direction.ts` is imported by `router.ts` ONLY. The investigation path never calls it.

**Fix direction (no phrasing, no verb table):** run the existing direction check against the
op the investigation chose, comparing it with the verb the extractor already found in the
prompt. Opposite source pocket or opposite health effect = a disagreement to surface, not a
choice to make silently. Adding "lend me" to any regex, list, or model-prompt sentence is
banned — that is the verb-to-op table the guard exists to replace.

### What this means for the lane decision
Investigate-first is not strictly safer. It fixes the invented-asset bug (`deposit it` → XLM)
and loses the direction guard. The conclusion is not "one lane is better" — it is that the
direction check must apply to whichever path does the planning.

---

## X5 (23 Sep, live UI) — swap → LP chain, and a loss-acceptance offer at ~95% loss

`swap 50 XLM to AQUSDC and add it as liquidity with XLM on aquarius`, understood correctly.

1. **The quote is a ~95% loss.** 50 XLM → 0.5728154 AQUSDC on Aquarius, against an oracle of
   ~$0.22/XLM (≈ $11.03 in, $0.57 out). The testnet pool is badly skewed (Soroswap was ~17% off
   in X4). The risk gate did refuse — correct.
2. **The refusal cites the wrong leg.** "The risk gate did not prepare this swap: add liquidity
   AQUSDC: a swap fills at the pool's price…" attaches the add-liquidity leg's rejection to the
   swap.
3. **It offers loss acceptance at ~95%.** "To continue at this price, state in chat that you
   accept the quoted loss." The accept-loss path (catalogue S2) exists for a modest priced-in
   loss; offering it at 95% invites a user to destroy the position. The offer should be bounded
   by the size of the loss, from the quote's own figures — not shown unconditionally.
4. **"The previous leg" after a swap is refused.** "a swap fills at the pool's price, so how much
   it buys is not known in advance — state the next leg's amount yourself." But the swap carries
   an enforced minimum output (slippage floor); that is a known lower bound and the LP leg can be
   sized from it. The catalogue expects X5 to chain.
