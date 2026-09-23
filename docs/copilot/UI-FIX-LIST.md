# Copilot UI fix list — collected 23 Sep during the live browser pass

Not started. Collected while testing prompts on `try/investigate-first`; do these as one
pass after the logic fixes, since several touch the same card.

## 1. "Understood as" repeats the prompt verbatim
`What's my health factor?` → **Understood as: What's my health factor?**

A restatement that is identical to what was typed tells the user nothing and takes a heading
plus a line. Show it only when the understanding actually differs from the prompt — which is
exactly when it is worth reading (`lend me 30xlm` → "Borrow 30 XLM on margin" is worth
showing, and is how the user caught that bug).

## 2. The prompt is printed twice on a plan turn
The user bubble says `lend me 30xlm`, and the PLAN FOR APPROVAL card repeats `lend me 30xlm`
as its own title, a few lines below. One of the two should go — the card already sits under
the turn it belongs to.

## 3. Two advisory notes hang below every plan card
> The Margin page snapshot and the contract liquidation snapshot disagree, so I did not quote
> a borrow size. Tokens sitting in the margin account that are not posted as collateral count
> toward the figure shown on the Margin page, but not toward what the liquidation engine sees.

> $1058.12 in your account is not posted as collateral — it does not back borrowing, and it
> can be withdrawn without touching your health factor.

Both appear on unrelated prompts and are mostly noise at this length. Either fold them into
the card, or show them only when they change what the user would do.

## 4. Cancel button in the composer
Needs a fix (reported 23 Sep, detail to confirm with the user before changing anything).

## 5. General card cleanup
Requested alongside the above — reduce what a plan turn prints by default.

## Still open from the night before (not yet re-verified in the browser)
- Execution card appearing ABOVE the plan card, and misaligned. A fix landed (`7821c0a`:
  a receipt is only written once a run leaves `proposed`), but it has NOT been confirmed on
  screen yet.

## Not a UI bug — recorded so it is not re-filed as one
`lend me 30xlm` renders "Borrow 30 XLM" correctly; the card is faithfully showing a WRONG
UNDERSTANDING. That is the debt-guard defect, tracked in FIX-LIST-copilot-upgrade.md.

## 6. A cancelled plan still shows an EXECUTION PROGRESS card  (E2, 23 Sep)
"Cancel remaining steps" on `supply 25 AQUSDC to earn` left an EXECUTION PROGRESS card with
its one leg reading **Queued**, directly above "Not executed — Remaining steps cancelled."
Nothing ran, so there is no execution to show.

Cause: the receipt effect in `copilot-workspace.tsx` skips `proposed` and `validating` (fix
`7821c0a`) but writes a receipt for every other status, `cancelled` included. A receipt should
exist only once a leg has actually been submitted; a run cancelled before any leg started has
nothing to record. Decide from the steps' own state (any leg past `pending`), not by adding
`cancelled` to a list.

## 7. Execution card renders in the wrong place, and the headline goes stale  (lend 20 xlm)
After a real run settled, the EXECUTION PROGRESS card sat ABOVE "Checked in / Understood as",
with the plan card replaced by a separate "Done" card below. It should take the plan card's
place. The turn headline also kept reading "Approve to run this step." after the run was done.

## 8. Plain actions should not need Approve under auto-approve ON  (product rule, 23 Sep)
Catalogue §2: a plain action with auto-approve ON executes directly with no plan card; only a
strategy shows a plan card first. Investigate-first currently puts an Approve card on every
write, including "lend 20 xlm". This is the one real product regression the experiment
introduced — design it after the catalogue run.

## 9. vToken amounts are labelled as the underlying token  (E4, E5)
`redeem all my AQUSDC from earn` renders one step as
"Redeem 14.8783043 AQUSDC vTokens from Earn (≈ 15.1755174 AQUSDC) (14.8783043 AQUSDC)" —
two parentheticals, two numbers, both labelled AQUSDC. The trailing figure is the vToken count.
The pocket underneath repeats it: "Earn · AQUSDC 14.8783043 available — Plan spends 14.8783043".
Label from the amount's own unit, not the leg's asset: a vToken amount should say vAQUSDC.

## 10. Past turns lose their outcome once you move on  (E3, E4, E5)
After a new prompt, or after opening another chat from Recents, a planning turn collapses to its
headline alone — "Redeem 9.9451295 XLM vTokens from Earn (≈ 10 XLM). Approve to run this
step." — with no card, no status and nothing to approve. The instruction is left standing for
a plan that is no longer there.

Every past turn should carry its FINAL state, from the workflow record, not from the live card:
- executed — the settled legs with their tx links
- cancelled — "Cancelled, nothing submitted" (distinct from item 6, which is a cancelled run
  wrongly showing a live execution card)
- stopped mid-way — which legs settled and which did not
- never approved / expired — "Not approved — this plan expired"
And the headline must stop saying "Approve to run this step" once approval is no longer possible.

## 11. Multi-figure answers need structure  (E6)
`what is my earn position?` returned four pools as one run-on sentence:
"Earn XLM: 44.8665031 VXLM (redeemable for ~45.1140483 XLM). Earn BLUSDC: 99.056705 VUSDC …"
Unreadable at a glance. An answer carrying several comparable figures should render as rows —
one per pool, vToken balance and underlying in their own columns — not prose. This is a
rendering rule for structured answers generally, not a fix for this one prompt.

## 12. A turn is the model's answer, not a stack of panels  (general rule, 23 Sep)
`lend 5 AQUA` rendered: the answer sentence, then "Understood as", an **Options** block with
"Ruled out: Lend 5 AQUA. lend AQUA: no AQUA price was read…", a collapsible **"How these figures
are made"**, and two warning bullets ("asset price: data was unavailable. No value was
assumed." / "$1059.53 in your account is not posted as collateral…").

The rule, for every prompt: show the model's response. Options, ruled-out lists, the figures
explainer and the advisory bullets are removed. When the model needs to say why it did not do
something, it says so in the response text — not in a separate card. The one card that stays
is the plan-for-approval card on a strategy, since that is where a decision is made.

## 13. FIXED 23 Sep — a failed propose retried itself forever
A failed `/workflow/propose` released its dispatch claim and reset `workflow.view`/`loading`,
which are the dispatching effect's own dependencies, so it re-fired instantly. A broken route
produced `POST /workflow/propose 404` several times a second. The effect now stops while
`workflow.error` is set; a retry is the user resending.

## Test hygiene (not UI)
`investigation-plans-e2e` writes real entries into `.local/copilot-audit` (`subject: "user"`).
Tests should use a temp directory.

## 14. "Done" is declared after the FIRST leg of a multi-leg run  (X1, 23 Sep)
`deposit 100 XLM as collateral and borrow 20 BLUSDC`: mid-run the page showed the deposit
Settled, the borrow **Queued**, and beneath them "Done — All approved transactions were
confirmed on chain." Both legs did settle (BLUSDC debt +20 exactly), but the completion
message was rendered while a leg was still pending. Had leg 2 failed, the user would have
been told the run succeeded. "Done" must be derived from every leg being settled, never from
the first confirmed transaction. This one is a correctness bug in the status, not cosmetics.

## 15. One execution card, in place — no separate "Done" card  (X1, 23 Sep; supersedes 7 and 14)
Today a run shows up to THREE things: an EXECUTION PROGRESS card (rendered above "Understood
as"), the plan card, and afterwards a separate "Done — All approved transactions were
confirmed on chain" card below.

The design: the plan card becomes the execution card when Approve is clicked, in the SAME
place, and it is the only card for that run. It carries the progress — each leg moving
Queued → Submitting → Settled with its tx link — and its final state is simply every leg
Settled (or the one that failed, and why). No "Done" card.

This absorbs item 7 (card rendered in the wrong place) and removes item 14 (a "Done" card
announcing completion while a leg was still Queued) by construction: with no Done card there
is nothing to declare completion early, because completion is read off the legs themselves.

## 16. Refusals are internal validator strings, shown raw and twice  (X2, 23 Sep)
`deposit 100 XLM, borrow 20 BLUSDC and supply it to blend` answered:
"I checked the shape against your position and the live rates, and none could be prepared:
Deposit 100 XLM, then Borrow 20 BLUSDC, then Supply 20 BLUSDC — supply blend BLUSDC: the
amount 20 does not appear in your request. Nothing was executed."
— and then repeated the same string in a "Ruled out" card below.

"supply blend BLUSDC: the amount 20 does not appear in your request" is a check's internal
message (op name, asset, rule). A user cannot tell from it whether they did something wrong,
what to change, or whether it is the system's fault. When nothing can be prepared, the model
says so in its own words, once, with what the user can do next. Part of item 12, called out
because here the raw message was also WRONG (see FIX-LIST: X2 amount provenance).

## 17. Raw 18-decimal WAD figures reach the user  (X3, 23 Sep)
"only 15.175689561344202486 AQUSDC is redeemable from Earn" — 18 places, the internal fixed-
point precision. AQUSDC has 7 on-chain decimals. Any amount shown to a user is formatted to the
token's own decimals (the registry knows them), never the WAD it was computed in.

### Item 12, refined (23 Sep): when an Options block may appear at all
Only for a STRATEGY prompt that produced MORE THAN ONE candidate — that is the one case where
the user has a real choice to make between options. A plain action, a single-candidate plan,
and every refusal get no Options block and no "Ruled out" entry; a refusal is said in the
model's text (item 16). Seen wrongly on X5 and on "i accept the loss", both of which rendered
"Options → Ruled out: …" for a single, already-refused plan.
