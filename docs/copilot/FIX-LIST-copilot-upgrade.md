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

### Implemented by Codex Luna — verified by Codex Sol, 23 Sep

The investigate proposal path now compares a single proposed write with the same prompt's
single deterministic `routeMessage` write using `disagreesOnNewDebt` and `OP_FLOW`. A debt
direction mismatch returns a clarification before a proposal is journaled. The guard covers
both composed and stated-action proposals; ambiguous or multi-write router readings are left
to their existing handling. No phrase rules or normal router behavior were added or changed.
Targeted plus neighbouring invariant tests passed in the Sol review: 45/45 across
`investigation-proposal`, `debt-reading-disagreement`, `investigation-answer`, and
`leg-direction-invariant`. `npx tsc --noEmit` and `git diff --check` also passed.

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

### X5 follow-up — "i accept the loss" dead-ends, and must NOT be fixed alone
Replying "i accept the loss" re-planned correctly ("Swap 50 XLM to AQUSDC and add as liquidity
… accepting any potential loss/slippage") and was refused: "swap XLM: the amount 50 does not
appear in your request." The anchor leans on the LATEST message (`requestText` = last message;
`uniqueAmountsIn(request)`), and on a follow-up turn the latest message carries no number. The
carried-amount rule added in 912afc6 also reads `request` and should read the whole
conversation for the same reason.

**Owner decision, 23 Sep (supersedes an earlier ordering constraint):** when the user
explicitly accepts the quoted loss, the swap executes — at any size. A ~95% loss was flagged and
Aditya decided this is the correct behaviour: a user who states they bear the loss is not
overridden. Do NOT add a loss-size bound to the accept path.

**Fixed (next commit):** the literal-amount anchor now also accepts an amount the deterministic
extractor independently reads, with the same op and asset, from ANY turn of the conversation — so
"i accept the loss" keeps the 50 XLM stated a turn earlier.

## X7 (23 Sep, live UI) — LP exit → repay
`remove my XLM/SOUSDC liquidity and repay my BLUSDC debt` sized "Remove 11.0639364 XLM/SOUSDC LP
shares → Repay 339.6414649 BLUSDC".

1. **Wrong-token decision copy.** "Using SOUSDC — you hold 340 of it, so no swap is needed" is
   printed on a plan that repays BLUSDC. Looks like the USDC-variant decision (`rankFeasible` →
   `variantDecision`, which runs over `USDC_SET`) attached to a repay whose asset it did not pick.
   BLUSDC debt cannot be repaid with SOUSDC without a swap. Verify which leg the copy belongs to.
2. **HF projected DOWN on a repay.** "Health factor after 1.95" against a live 2.30, while
   repaying 339.64 of debt. Either the LP exit removes more collateral value than the repay
   frees, or the projection is wrong. Not determined — needs the simulation numbers.
3. **Propose cannot see what research read.** "Prepare this plan" → "no SOUSDC LP position was
   read this investigation. Start a new investigation." The option was sized from that very LP
   read. The LP position evidence is not carried in the continuation to propose.

## X11 (23 Sep, live UI) — "borrow to the floor" ignores the user's floor, and invents the asset
`deposit 100 XLM then borrow to the floor`, two runs, two behaviours:
- run 1: asked which asset AND which floor
- run 2: assumed **XLM** as the borrow asset (never stated), then refused: "borrowing to the floor
  needs the health-factor floor you want kept … tell me the number"

1. **Invented borrow asset.** An empty slot filled by a default — the same class as
   `deposit it` → XLM. Run 1's behaviour (ask) is correct; run 2's is not.
2. **The configured floor never reaches the server.** The health bar shows "1.40 your floor",
   read from `localStorage["vanna_copilot_guardian_min_hf"]` (`readGuardianFloor`,
   copilot-workspace.tsx:452). `/api/copilot/investigate` never receives it, and `inputFrom`
   REJECTS any key outside {message, wallet, continuation, session, history, conversationId}.
   So "to the floor" has nothing to resolve against.

   Fix path: send the floor with the request (route accepts it), carry it into the
   investigation scope, and let `to_floor` sizing use it when the user states no number. Note a
   standing concern: a risk floor that also drives auto-repay lives only in one browser's
   localStorage, so another device or a cleared profile silently falls back to 1.3.

### X11 follow-up ("1.5") — a real ~$1,226 borrow with an unchosen asset, unsimulated
After the user answered only the floor, the plan was "Deposit 100 XLM → Borrow 5563.1120041 XLM,
HF after 1.50". Correct as ONE plan (catalogue X11), but:
- **Asset never chosen:** XLM carried from run 2's default into a live borrow of ~$1,226.
- **Borrow leg unsimulated:** "Deposit 100 XLM as collateral allowed (LTV 55.58% after); the other
  step follows from it and stand on the projection." The leg that moves health most is the one not
  put to the protocol's preview. (Also: "stand" → "stands".)
- **Wrong answer template:** "$1,226.00 using idle funds only; the supply rate could not be read
  this time." That is the non-borrowing summary (answer.ts ~253) applied to a borrow plan.

### X11 answer template — implemented by Codex Luna, verified by Codex Sol, 23 Sep

The structured strategy reply now reads the candidate's step ops. A composed plan containing
`borrow` can no longer claim it uses idle funds only, including when its supply rate was not
read; the honest fallback says the plan includes borrowing and leaves the unavailable rate
unquoted. A composed plan with no borrow leg retains the idle-funds wording. No prompt-text
regex, asset special case, UI layout, or card content changed. Covered by two focused
regressions in `tests/lib/investigation-answer.test.ts`; included in the 45/45 Sol run above.


### Owner corrections, 23 Sep (supersede the X7 / X11 notes above where they conflict)
- **X11:** asking the user for the floor is the INTENDED behaviour — "to the floor" requires a
  number from the user. Inferring an XLM borrow from "deposit 100 XLM then borrow" is correct
  intent. Neither is a defect. (The localStorage-only guardian floor falling back to 1.3 on
  another device remains a separate concern.) Still open from X11: the borrow leg unsimulated,
  and the "using idle funds only" summary on a borrow plan.
- **X7:** the plan shape (LP exit → repay) is correct. The notes above are downgraded to VERIFY
  items, not defects; the observed one to check is the "That option no longer sizes on the
  current reads" message after Prepare.

## Queued 23 Sep (owner decision on X12/X14): fix after the XS pass

1. **Venue scope follows the prompt.** The venues the user names (Earn / Farm / Margin, one or several) form ONE plan covering exactly those. "All" / "everything" means every venue. The model reads the scope (no keyword list); "Understood as" already reads it right. The defect is the split into competing Options. Options are alternatives only.
2. **Withdraw-all ordering across venues:** exit Farm → repay debt from what came back → withdraw collateral → redeem Earn. When held tokens cannot cover a debt asset, say so plainly, never skip the margin account silently.
3. **No venue named, funds in several:** show the per-venue holdings in structured form and ask which.
4. **Invented repay:** X12 ruled Margin out on "repay SOUSDC … larger than the outstanding debt" while the account holds no SOUSDC debt.
5. **Farm option "$0.00" and "Blend 181.9…" label** with no verb. Blend/LP exit legs carry no USD value.
6. **X14 LP exit → next leg:** size remove_liquidity's payout from the LP position read (share × reserves, min-out tolerance) so a previous_leg handoff has a figure. `producedAsset` knows one asset per leg, which is why the refusal says "needs a preceding leg in the same asset". It is shared by every handoff, so run the full plan suites.
7. **Done locally, uncommitted:** `valueMovedWad` (plan.ts) plus `tests/lib/plan-value-moved.test.ts`. The Earn "withdraw all" amount now sums independent legs.
8. **X14 ran blind:** farm overview, farm LP position, Blend reserve and LP balance all came back "data was unavailable". Check plan_reads `ok:` vs `requested:` and the MCP logs (ECONNRESET is the usual cause) before touching read selection. Item 6 depends on the LP position read.
9. **Tests pollute the real audit log:** vitest runs appended 8 "proposed" rows to `.local/copilot-audit/2026-09-23.jsonl` (08:25–08:32 UTC). Ignore those rows when reading the log.
10. **XS5 "unwind my positions safely and leave me with the least risk" produced nothing.** Stream: status `researched`, `candidates: null`, warnings: earn position unavailable, farm LP position unavailable, "2 proposed strategy shapes could not be read". (a) One `earn_position` read and one `farm_lp_position` read errored in each turn (e7/e9, e13). XLM is missing from the Earn list, though X12 read 44.87 XLM vTokens. (b) Both model plans were dropped by `parsePlan`/`parseLeg` in decision.ts, which return null with NO reason (`refuse()` is only used for findings). First step: record each drop reason (per leg: key / op / asset / sizing) in the result checks and server log, then fix the rule that fired. Do NOT guess which. (c) With nothing sized, the reply is a raw balance dump with no statement that no plan could be built or why.
11. **Correction to X12 item 4:** there IS SOUSDC debt (21.98 SOUSDC, per XS5's debt read). "repay SOUSDC larger than the outstanding debt" is a repay sized ABOVE a real 21.98 debt, not an invented asset. Check what the repay was sized from.
12. **XS6: an objective answered with a question.** "earn the most" / "least risk" are selection rules over readings the copilot already has. It must apply them (best readable rate per asset) and plan, not ask the user to pick a venue. Ask only when a needed reading is missing or two readings tie. Same family as the X12 split-into-options defect (item 1).
13. **Rate label inconsistency:** Earn is shown as APR in the clarifying question and as APY in answers (E7 fix). One convention everywhere.
14. **Read failures are recurring across rows** (X14, XS5, XS6: earn_position, earn_market, farm_lp_position, farm_overview, blend_reserve, lp_balance). Diagnose once, centrally, before per-row fixes.
15. **A stated reserve must bind the sizer.** "keep 100 XLM liquid" was in the request history, yet an all_idle XLM leg spent the whole 2152.29. The mechanism: all_idle / fraction-of-idle for an asset with a stated reserve must size to (spendable − reserve), and the verifier must stop a plan that spends into the reserve. Carry the reserve as a structured constraint the model fills (like the floor), not a phrase match.
16. **Aborted investigate stream leaves a half-rendered reply.** XS7 "blend": the request ended ERR_ABORTED, and the page kept the summary sentence with no cards or Approve. Find what aborts it (a second request? the session DELETE seen before each investigate?) and make a cut-off reply say it was cut off. Check whether the "Cancelled. Nothing was submitted" lines (XS6) are the same abort.
17. **HF projection not additive:** 2.02 / 2.13 alone but 2.35 combined (XS6/XS7). Verify against the RiskEngine before fixing.

### Fix 3 (reserve), done locally 23 Sep, uncommitted, awaiting live verify
- The model fills `goal.walletReserves: [{asset, amount, sourceQuote}]`. The schema field is in decls.ts; there is NO prompt text.
- decision.ts parses it strictly: registry token, decimal, and the quote must contain the number. A bad row is dropped alone.
- floor.ts `anchoredWalletReserves`: the quote must be in a message the user sent (any turn). The larger amount wins when a token is named twice.
- candidates.ts `holdingsAfterReserves` / `idleWalletAfterReserves` take the reserve off the spendable wallet balance where it is read. That covers all_idle, fraction-of-idle, stated amounts and the fixed "supply idle X" shapes.
- Sealed on `evidence.walletReserves`, and proposal.ts re-sizes with it, so the propose path keeps it. Execution runs sealed amounts, so it cannot re-spend the reserve.
- Refusals name the reserve ("after the 100 XLM you asked to keep" / "inside the … you asked to keep").
- Tests: `tests/lib/wallet-reserves.test.ts` (10). The 13 affected suites (245 tests) have identical results before and after (2 pre-existing e2e failures).
- Not covered: the model omitting the field entirely (same limit as the floor). A stated-actions literal that contradicts its own reserve goes through the literal path.
- Live check once the server is back: XS7 → reply "blend" → the XLM deposit must be ≤ spendable − 100.

### Done locally 23 Sep (uncommitted)
- **Fix 3, reserve: VERIFIED LIVE.** XS7 re-run: the Earn plan lends 2052.2879106 XLM = 2152.2879 − 100. The fixed Blend option ($445.55) matches the same 2052.29 XLM. Refusal wording joined: "after the legs before it and the 100 XLM you asked to keep".
- **Scroll (owner, 23 Sep):** on send the view jumped to the bottom and the user's message scrolled away. copilot-shell.tsx now pins the latest `[data-cp-user-bubble]` to the top, with a spacer that only shrinks as the reply grows (the ChatGPT/Claude pattern). It no longer follows the reply down after a send. A restored chat still opens at the bottom. Tests: copilot-shell-scroll (3). Awaiting the owner's live check.
- **APR → APY (owner, 23 Sep):** `lib/copilot/investigation/apy.ts`. Earn is shown as-is (what the Earn page labels "Supply APY"); Blend is compounded weekly via the Farm page's `blendSupplyApyFromApr`. Mixed plans are converted leg by leg, then weighted. New `supplyApyPct` / `netApyPct` on every candidate (fixed shapes and composed). The reply prose quotes APY and falls back to a correctly labelled APR. The APR fields remain what the sizer and carry guard judge by. Tests: plan-apy (4), and the investigation-answer spec updated.
- **PENDING OWNER OK:** the "% APR" label on the plan CARD comes from `rateOf` in investigation-card.tsx (lines 73–78), authored by sanujit (e874870a). It is another dev's card content, so it is not changed without the owner's go-ahead. The one-line change would be to read `netApyPct`/`supplyApyPct` and say "APY".
- strategy-options-grid.tsx also prints "% net APR", but it is imported nowhere (dead). Left alone.

### Other agents' work, verified 23 Sep (Claude)
- **Codex, answer.ts (uncommitted in this tree):** a plan whose steps include a `borrow` no longer gets "using idle funds only". It says "this plan includes borrowing". Decided from the step list, not wording. Covers X11/X13 on borrow plans. It does NOT yet cover withdrawals (X12's redeem/withdraw still say "using idle funds only"). Tests: investigation-answer (2 new).
- **Codex, proposal.ts (uncommitted):** the debt-disagreement guard now compares against `routeMessage` (stop-only, never builds) and runs on BOTH propose paths: requested actions (line 107) and composed (line 295). Mine only ran on the composed path, which is why "lend me 20xlm" never tripped it. It replaced my `clauseToStep` version. Tests: investigation-proposal (3 new) and debt-reading-disagreement. 30/30 pass.
- **Grok, MCP `8d98ec6` "Return a numeric Soroswap pool fee with the reserves":** the second half of the X10 leg-5 root cause (fee `""` when SOUSDC is asked first). It reads token_0 via a strkey parser that also handles the Address repr, and derives the fee from the router's own quote at several probe sizes. Deployed: `vanna-mcp-server-00106-rwj` at 11:10 UTC (after the 11:06 UTC commit). MCP farm tests 13/13.
- **Grok handoff (docs/copilot/HANDOFF-2026-09-23-grok.md), two owner questions:**
  1. `rankingBorrowing` returns "required" when ANY plan borrows, so a no-debt plan beside a levered one is hidden. This is the cause of the 2 pre-existing investigation-plans-e2e failures.
  2. X10 on deployed dev: "borrow SOUSDC: the 2x leverage does not appear in your request". The model's quote for the second borrow lacked the "2". The multiple is written once for two assets.

### More done locally 23 Sep (uncommitted)
- **"aquarius lp" / "could not be completed from the reads it made": FIXED.** Owner's log: `evidence refused { rejects: ['p1: 77252ms old', 'e0: 71553ms old'] }`. Carried reads were 54s old at the start of the follow-up turn, the turn took 23s, and the finish-time freshness check voided the run. service.ts now reuses carried reads only if they will still be fresh at start + the loop budget (`boundedLimits().maxDurationMs`, 45s); otherwise it re-reads (~5s). The instant health answer keeps the at-start check. Test: investigation-diagnostics.
- **Diagnostics (fixes 4/5 groundwork):** hidden `view.diagnostics` = stopReason + stopDetail (`result.stopDetail`; outcome shape unchanged), droppedPlanReasons (each parser drop now names its rule and the offending key or value), failedReads (capability, args, error text). Also logged as `plans_dropped` / `reads_failed`. Suspect for XS5: a remove_liquidity leg carrying `assetOut` drops its whole plan (only swap and add_liquidity may). Confirm from live diagnostics before changing.
- **Fix 9, aborted replies: INSTRUMENTED, cause not yet proven.** Every abort site now passes a label ("cancel pressed", "wallet changed", "replaced by a newer prompt", "120s client deadline", …), and `run()` logs `[copilot] investigation aborted {reason}`, which reaches the dev terminal as [browser]. Leading hypothesis: Send becomes Cancel in the same spot the moment a run starts (copilot-workspace ~6182), so a second click cancels. That fits XS6's "Cancelled" then re-sent prompt. UI-FIX-LIST 4 says confirm with the owner before changing the button.
- **Fix 12, exit-only wording: FIXED.** A plan that deploys nothing (`deploysIntoPosition` over OP_FLOW) gets no rate or idle-funds sentence. Codex's borrow wording and its "supply_blend alone = idle funds" rule are left as Codex wrote them. Test: investigation-answer (1 new, 18/18).
- **Fix 8a, Blend exit label: FIXED.** `verbOf` (plan.ts) took the op name's first word, so `blend_withdraw` was labelled "Blend 181.9 BLUSDC". It now takes the first word that is not one of the op's own OP_FLOW pockets, and the hand-written `supply_blend` case is gone. All 11 ops checked: only blend_withdraw's label changes. Plan suites identical to baseline (146 pass, the same 2 plan-shape-matrix failures).

## REMAINING, as of 23 Sep evening (one list; supersedes the scattered notes above)
Logic, in the order being worked:
- **A. Farm option "$0.00"** (X12): Blend and LP exit steps carry no USD value.
- **B. One plan for the venues named; "all" = every venue** (X12, XS6), with withdraw-all order (exit Farm → repay → withdraw collateral → redeem Earn).
- **C. Repay sized above the real debt** (X12: "repay SOUSDC: larger than the outstanding debt"; the debt is 21.98 SOUSDC).
- **D. Dropped plans** (XS5): waiting on live `diagnostics.droppedPlanReasons`. Suspect: remove_liquidity carrying `assetOut`.
- **E. Failed reads** (X14, XS5–XS7): waiting on live `diagnostics.failedReads`.
- **F. LP exit → next step** (X14): size the exit's payout from the LP position.
- **G. Missing deposit before add liquidity** (XS6 Aquarius): compose the deposit as Blend already does.
- **H. Unsimulated later steps** (X11, XS6): "the other step follows from it and stand on the projection".
- **I. HF not additive** (XS6/XS7: 2.02 / 2.13 alone, 2.35 together): verify against the RiskEngine first.
- **J. Older logic items:** X5 swap→LP sized from the swap's minimum output; X5 refusal cites the wrong leg; X10 card said "Not executed" though 4/5 settled; `execute.ts` staleLiquidityAmounts has an empty `catch {}`; AQUA refused on a price failure instead of the registry; bare "USDC" silently resolved (S5, G1); the empty-planning-turn "available capabilities" message; the guardian floor falls back to 1.3 from localStorage.
- **K. Test hygiene:** tests append to the real `.local/copilot-audit`.

Needs an owner decision first (parked):
- **Cancel button** sits where Send was (fix 9 hypothesis; UI-FIX-LIST 4). The abort labels will confirm the cause.
- **Grok's two questions:** the ranker hiding no-debt plans; one "2x" across two assets.

UI pass (last, as one batch): target layout (UI-FIX-LIST 21), structured replies (22), per-venue Plan A/B/C instead of a bare venue question (XS6/XS7), the model's clarifying question still quoting "APR", stale advisory notes, humanizer research (prose style only).
- **A. Farm "$0.00": FIXED.** (1) `valueMovedWad` now sums every step, so the Blend exit's value counts. (2) New `lpExitUsd` (plan.ts) values an LP exit as the shares' slice of each reserve × oracle price, from the pool-reserves read. `readsForPlans` now requests that read for any step whose OP_FLOW source is "lp". No pool read or price → "0", as before. Tests: lp-exit-value (4). The 25 affected suites have the same 7 failures as the baseline worktree.
- **C. Repay sized above the debt: FIXED.** Reproduced: when the contract snapshot's USD debt total is below the per-token debts × oracle price (the sources disagreed in X12), the last of four repays failed with exactly "repay SOUSDC: the repay is larger than the outstanding debt". sizing.ts `LegRequest.withinPosition`: a repay already inside its own token's debt read pays the projected total down to zero instead of failing. plan.ts sets it only after checking the repay's tokens against that token's debt read, less earlier repays of it in the plan. A first version inferred the bound from how the leg was sized; plan-shape-matrix caught a fraction-of-idle repay with nothing owed slipping through, and it was replaced with the direct check. Direct `sizeLegs` callers keep the strict check ("Overpay" test unchanged). Tests: repay-all-debts (3; the first fails on the old code). 25 affected suites have the same 7 failures as the baseline.
- **B (one plan for the venues named): ON HOLD for the owner.** The workflow journal refuses more than 8 steps per plan (journal.ts:43; the sizer has the same cap). A full X12 unwind is about 15+ steps. Proposal: join plans only when the model marks them as parts of one request (with the user's quote) AND the joined plan fits 8 steps; otherwise keep today's Options with an honest "too big for one approval" note. Staging vs a higher cap is for the owner to decide later.
- **G. Missing deposit before an account-spending op: FIXED (owner chose to keep it).** `expandLegs` (plan.ts): an op that spends the margin account and does not return to the wallet (OP_FLOW: supply_blend, swap, add_liquidity), sized from the idle wallet (all_idle / fraction of idle), becomes deposit_collateral + the op on previous_leg, exactly as repay already did. A deposit the model wrote itself is reused, not doubled. Stated amounts are unchanged ("supply 100 XLM" with nothing deposited is still refused). Behaviour change, owner-approved: idle wallet tokens become margin collateral inside the approved plan. plan-resolve's "Blend supply from the wallet directly" refusal row was removed for that reason. Tests: idle-into-account-ops (4; 2 fail on the old code). 38 suites / 400 tests: the only difference from the baseline was that row.
- **B. Join the parts of one request (≤ 8 steps): BUILT.** `goal.planRelation {kind, sourceQuote}` (schema, decision parser, `anchoredPlanParts`). `joinPlanParts` keeps each part's leg order, orders parts by OP_FLOW stage (leave a position → raise health → neutral → lower health), refuses when two parts share an op+asset, and adds no legs. `resolveJoinedOrParts` keeps the joined plan only if it sizes and fits `MAX_WORKFLOW_STEPS` (8, now exported from journal.ts and used by the journal itself); otherwise it sizes the original parts exactly (test asserts deep equality with the no-join result). Too long → the warning "takes N transactions, more than one approval can run". Tests: plan-parts-join (9). 19 suites: the same 4 failures as the baseline. X12's full unwind (~15 steps) still needs staged approvals (DESIGN-staged-approvals.md).
- **Checkpoint #1 = `2a6cf30`** (local, not pushed): all code and tests from this pass, including Codex's interleaved answer.ts/proposal.ts edits.
- Note: two large vitest runs failed to load every file ("no tests") while the same set loaded fine on rerun. It is intermittent, not code; rerun before drawing conclusions.
- **H. Unsimulated later steps: FIXED (checkpoint #2).** simulate.ts `conservativelyPreviewable`: a step that lowers health (borrow or withdraw) with only health-raising steps before it (deposits) is now put to the protocol preview against today's account. "Allowed" there still holds after the deposit, and pool limits are independent of it. It is reported as "allowed (checked before the steps ahead of it)", with no misleading pre-deposit LTV. A refusal is inconclusive and stays projected. Steps that need earlier tokens (supply after a deposit) are unchanged. Singular grammar fixed ("follows from it and stands"). Tests: simulate-conservative (3); investigation-simulate unchanged. Simulate-related suites: the same failures as the baseline. simulate.ts is mostly sanujit's module; this is logic, not card content.
- **I. HF "not additive": NOT A SIZING BUG (analysed, no code change).** HF = gross ÷ debt (sizing.ts:97). XS6's three figures (2.02 for +$464.13, 2.13 for +$679.98, 2.35 for +$1,144.11, debt $2,082.23) each imply the same starting collateral, ≈ $3,749 (3,742 / 3,755 / 3,749, within the ±$10 rounding of a 2-decimal HF). So the start is a contract HF ≈ 1.80, and every deposit raises it. The rail's 2.30 includes ≈ $1,059 of unposted tokens the liquidation engine does not count (the existing "not posted as collateral" note). UX fix for the UI pass: the card should show "Health factor 1.80 → 2.02" (contract basis before → after), not "after" alone next to a rail on a different basis.
- **J1. Swallowed LP-refresh error: FIXED (checkpoint #3 `a4bf10d`).** execute.ts `staleLiquidityAmounts` now logs `[copilot] LP reserves refresh failed {venue, tokens, why}` with the thrown error or the unusable payload (MCP errors arrive as 200s). The refusal is unchanged. Execute/liquidity suites: only the 2 baseline failures.
- **J2. X10 "Not executed" after 4/5 settled: FIXED (checkpoint #4 `542fd78`).** investigation-card.tsx (the line is Aditya's, 248762e9): a stopped run with settled steps reads "Partly executed: N of M steps settled". None settled still reads "Not executed". Test: investigation-card-partial-run (3). Component suites identical to the baseline.
- **J3. Guardian floor fallback: DROPPED.** Owner decision on X11: asking for the floor is correct.
- **J5. Bare USDC silently resolved (S5): FIXED (checkpoint #5 `0871f50`).** Registry: `namesAsset(text, id)` (the asset's own aliases) and `mentionsBareUsdc(text)` (USDC with every variant alias removed first, so "Blend USDC"/"AQUSDC" never count). plan.ts: a leg (asset or assetOut) in a USDC variant is refused with "you said USDC without saying which one: BLUSDC, AQUSDC, SOUSDC?" when the user said bare USDC and never named that variant in any turn. A request that never said USDC is unaffected. Tests: bare-usdc-plan (5). 30 suites / 439 tests: the same failures as the baseline. Not covered: G1 "USDC pool stats" (a read question on the answer path).
- **J6. AQUA refused for a missing price instead of the registry: FIXED (checkpoint #6 `c81255a`).** plan.ts checks the venue's registry support (earnSymbol / marginSymbol) BEFORE the price, so "lend AQUA" says "AQUA has no Earn pool". The plan-resolve "no price read" row had pinned the masked reason via AQUA; it now tests the missing price with XLM (held, has a pool, price read removed). Test: bare-usdc-plan "an unsupported asset".
- **K. Tests wrote to the real audit log: FIXED (checkpoint #7 `e483782`).** audit-log.ts: `COPILOT_AUDIT_DIR` wins; under vitest (`VITEST` is set by vitest) the default is `<tmpdir>/vanna-copilot-audit-test`; real runs are unchanged. Proven: proposal and journal tests (38) ran and the real .local log stayed at 135 → 135 rows. tests/setup.ts (another dev's shared infra) is untouched.
- **X5 items: DROPPED (owner, 23 Sep).** Another dev said not to touch swap code. An uncommitted refactor of the swap floor (for sizing an LP from the swap minimum) was reverted; plan.ts equals checkpoint #7. OPEN QUESTION to the owner or that dev: J5 (bare USDC in a swap now asks which) and G (a swap sized from idle gets a deposit leg) affect swap requests without editing swap code. Keep them for swaps, or exclude swaps by mechanism?

### Live test run 23 Sep evening (owner driving, Claude watching)
- #1 price, #2 HF, #3 lend 5 XLM: pass (lend auto-executed, tx 6c89cb40…, ledger 4829533).
- #4 reserve + blend: pass (2047.2369004 = spendable − 100; one joined plan; APY on card and reply).
- #5 whole wallet + farm: pass (one 4-step plan). AQUSDC/SOUSDC absent: no Blend market, and the model proposed no LP.
- #6 withdraw all funds → asked which venue WITHOUT listing per-venue holdings (UI list). Reply "earn and farm" → ONE joined plan (B works live), label "withdraw 181.9 BLUSDC" (fix 8a works), then **propose 409 "no AQUSDC LP position was read"** and no card.
- **FIXED (checkpoint #8 `d624432`): evidence sealing dropped reads the plan needs.** The LP read had no priority (cut by the 16-read cap) and no compactData branch (sealed as {}). Now `compactResearchEvidence` takes `required` (from `readsForPlans(modelPlans)`), keeps it first and never cuts it; farm_lp_position keeps lp_shares_human, venue and tokens. Test: evidence-keeps-plan-reads (2). Evidence/service/proposal suites: the same failure as the baseline.
- #7 supply idle XLM to blend: the plan is correct (deposit + supply 2147.24), BUT "4 other options" for other assets came from the fixed-shape generator. QUEUED: when the user names an asset, drop fixed options for assets they did not name (registry `namesAsset`).
- Abort log: every abort so far is "replaced by a newer prompt" (benign: the next send closes the previous stream). No "cancel pressed".
- #9 lend my AQUA: "Ruled out … AQUA has no Earn pool" (J6 works live) BUT headed "Best path: Supply idle XLM to Blend" with 5 unrelated options. **FIXED (checkpoint #9 `fac865e`):** candidates.ts `onlyNamedAssets`, applied before `mergeCandidateSets`. When the user names assets (registry aliases; a bare USDC = all 3 variants), only fixed options for those assets remain. Naming none keeps everything; composed model plans are never filtered. Test: options-only-named-assets (4). Service/candidate/card suites: the same failures as the baseline.
- #11 X5 then "i accept the loss" → "the amount 50 does not appear in your request". **FIXED (checkpoint #10 `aa15e4d`):** the model quoted "Swap 50 XLM to AQUSDC" (capital S) for the user's "swap 50 XLM…", so `literalAmountAnchored` failed at the quote check before the independent reading (extractor over the user's own messages, which finds swap/XLM/50) ran. That reading now runs first; it never uses the model's quote. Tests: literal-amount-carried (+2: re-cased quote accepted, invented amount still refused). Suites: the 4 known baseline failures only. The swap→add-liquidity chain refusal is unchanged (swap design, off limits).
- #8 swap 100 XLM to USDC: J5 asked "which USDC" but inside the dev's swap card, with a SOUSDC quote and "accept the quoted loss". Owner chose (b): ask before a swap plan is built.
- #12 XS5 dropped plans and #13 X14 "no AQUSDC LP position was read": diagnostics lost (stream closed by the next prompt). Adding a dev-only diagnostics file.
- "lend AQUA" (after #9): no unrelated options. Owner: the main answer must come FIRST, then the idle summary.
- **Answer before the idle list: FIXED (checkpoint #11 `0e8d8da`).** answer.ts puts the findings first, then "Idle in the wallet…" (owner). Test updated.
- **#8(b) ask which USDC before a plan: FIXED (checkpoint #12 `e7abae3`).** plan.ts `unchosenUsdcVariant` / `USDC_QUESTION` is shared by the per-leg refusal and service.ts. Before sizing, plans with a leg in an unchosen USDC variant are held back and the turn asks "You said USDC without saying which one…?". The model's own open question, if any, stands. Other plans ("deploy my XLM and USDC") still size, and options are cleared only when every plan was waiting on the choice. So "swap 100 XLM to USDC" is just the question: no swap card. First version cleared every plan and broke 4 e2e tests; narrowed. e2e errors are now identical to the baseline's (the 2 ranker ones).
- **Dev-only diagnostics file (checkpoint #13 `b9df5f3`).** diagnostics-log.ts appends each turn's `view.diagnostics` (failedReads, droppedPlanReasons, stopReason/stopDetail) with the prompt to `.local/copilot-diagnostics/<day>.jsonl`. Skipped when NODE_ENV=production, K_SERVICE or VITEST; never throws. Lets an agent read why #12/#13 failed without the terminal.
- **Live re-check after #10–#13:** "swap 100 XLM to USDC" → asked which USDC, with no card (#12 works) → "aqusdc" → pool loss quote (94.42%) → "i accept the loss" → **executed** (swap 100 XLM for ≥1.1393778 AQUSDC, tx a6435899…, ledger 4829982, Settled). The dev's accept-the-loss design works end to end with the anchoring fix (#10).
