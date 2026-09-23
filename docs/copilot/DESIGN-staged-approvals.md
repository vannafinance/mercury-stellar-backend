# Staged approvals: design (draft for Aditya, 23 Sep)

## Problem

"Withdraw all funds" (X12) is about 15 transactions: 4 Earn redeems, 3 Farm exits, 4 repays,
about 4 collateral withdrawals. One approval may sign at most 8 (`MAX_WORKFLOW_STEPS`,
journal.ts). B joins a request into one plan only when it fits 8. Above that it falls back
to separate options with the note "takes N transactions, more than one approval can run".

## Proposal

Run a big request as **ordered stages**. Each stage is an ordinary plan of at most 8 steps
that goes through the existing propose → approve → advance path unchanged.

```
withdraw all funds
  Stage 1  Exit Farm           3 steps   [Approve]
  Stage 2  Repay debt          4 steps   (prepared after stage 1 settles)
  Stage 3  Withdraw collateral 4 steps   (prepared after stage 2 settles)
  Stage 4  Redeem Earn         4 steps   (prepared after stage 3 settles)
```

1. **Split.** When the joined plan is over 8 steps, split it at the part boundaries that
   `joinPlanParts` already orders (leave positions → raise health → neutral → lower health).
   Each stage holds whole parts. A part is never split, so its internal hand-offs stay together.
2. **Show.** The card lists every stage. Only stage 1 has a plan and an Approve button.
3. **Run.** Stage 1 is approved and runs exactly like any plan today.
4. **Re-plan the next stage on fresh numbers.** When a stage settles, the next stage is
   re-investigated: a fresh read of balances, debt and prices, and the same sizer and checks.
   It is then offered with its own Approve. Nothing is pre-signed from stale figures. This is
   the practice in agent wallets: approve the plan, re-validate before each execution
   stage ([7-stage pipeline](https://dev.to/walletguy/how-we-designed-a-7-stage-transaction-pipeline-for-ai-agents-4f4o),
   [human-in-the-loop approvals](https://dev.to/walletguy/human-in-the-loop-3-ways-to-approve-your-agents-transactions-4606)).
5. **Stop honestly.** If a later stage no longer sizes (for example the XLM debt is larger than
   the XLM in the account), it says so plainly and names what would unblock it, instead of
   running a partial plan.

## What it does NOT change (the non-interference promise)

- The journal, approve, advance, execute, the auto-sign rules and the 8-step cap are unchanged.
  Each stage is one normal proposal.
- Requests that fit 8 steps never see stages (they get B's single plan, or today's behaviour).
- Single-leg and multi-leg rules are unchanged: every stage with more than one step needs Approve and run.
- A running or pending plan is never touched. The next stage is only prepared after the current one settles.

## Open questions for Aditya

1. When stage 1 settles, should stage 2 be prepared **automatically** (shown with Approve), or
   only when the user presses "Prepare next stage"? Recommendation: automatic preparation,
   manual approval.
2. If the user leaves mid-way (stage 2 of 4), should the next visit offer to continue? Recommendation: yes, from the saved conversation.

## Tests it must pass before it ships

- An X12-sized request produces stages of at most 8 steps each, in the right order, with no part split.
- A request that fits 8 steps is byte-identical to B's output (no stage object at all).
- Stage 2 sizes from reads taken after stage 1 settled, never from the original reads.
- The existing journal, approve and advance suites pass unchanged against the baseline.
