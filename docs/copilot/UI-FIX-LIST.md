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
