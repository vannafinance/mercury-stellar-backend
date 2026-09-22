# The copilot lifecycle — one successful prompt, end to end

The run this follows is real (13 Sep 2026, signed-in `/copilot`, testnet, local MCP loop):

> **"use my AqUSDC sitting in Earn as collateral, keep HF above 1.15"**
> → redeem `e5e75d39…` settled → deposit `86f5bc5c…` settled, no click in between.

One rule: **the model proposes, the code disposes, the protocol decides.** Read top to bottom;
each column is who; each line is one hand-off. The shaded bands are the three phases.

```mermaid
sequenceDiagram
  autonumber
  actor User as User (card on /copilot)
  participant Code as Copilot server (code)
  participant Model as Gemini 3.6 Flash
  participant MCP as Vanna MCP
  participant Chain as Sign Service and Soroban

  User->>Code: "use my AqUSDC sitting in Earn as collateral, keep HF above 1.15"
  Code->>Code: scope: wallet G… → bindings → smart account C…
  Code->>MCP: position seed: margin snapshot, liquidation snapshot
  MCP-->>Code: gross collateral, debt, health factor

  rect rgb(243, 232, 255)
    Note over Code,Model: MODEL PROPOSES — words only, never a number
    Code->>Model: turn 1: the prompt, the seeds, the read catalog
    Model-->>Code: inspect: earn_position AQUSDC, account_health
    Code->>MCP: vanna_earn_position · balance, vanna_margin_status · health
    MCP-->>Code: observations e1…e4 (wire symbols annotated with registry assets)
    Code->>Model: turn 2: the observations
    Model-->>Code: research_complete: goal (strategy, no borrowing, floor 1.15 quoted), findings citing e1…e4, plan shape
    Note right of Model: plan = redeem AQUSDC · all_position → deposit_collateral AQUSDC · previous_leg
    Code->>Code: parseDecision: vocabulary and exact keys — anything else is dropped and counted
  end

  rect rgb(224, 242, 254)
    Note over Code,MCP: CODE DISPOSES — every amount traces to a read
    Code->>MCP: reads the plan still needs: price AQUSDC, wallet balances
    MCP-->>Code: observations e5, e6
    Code->>Code: size: redeem = whole vToken position, deposit = what the redeem lands, cut to on-chain precision
    Code->>Code: project HF after each leg — floor 1.15 is a stop condition
    Code->>Code: allowlist: vanna_redeem, vanna_deposit_collateral with exact arguments
    Code->>MCP: preview each step the chain can be asked about
    MCP-->>Code: allowed (RiskEngine snapshot) — or the protocol's own refusal
    Code->>Code: rank, write the rationale, seal evidence + plan + floor into a signed continuation
    Code-->>User: card: option, 2 steps, HF after, simulation line
  end

  User->>Code: Prepare this plan
  Code->>Code: re-size the sealed plan (re-read if stale), preview again, journal the proposal
  Code-->>User: steps to approve
  User->>Code: Approve
  Code->>MCP: live balances per holder, price, precision, contract health
  Code->>Code: replay the funds flow and the health projection over both steps
  Code-->>User: approved, running

  rect rgb(220, 252, 231)
    Note over Code,Chain: PROTOCOL DECIDES — the chain has the last word
    loop each step: redeem, then deposit
      Code->>MCP: build the transaction
      MCP->>Chain: RPC simulation (a HostError here means nothing is submitted)
      MCP->>Chain: sign under the auto-sign session policy, submit
      Chain-->>Code: tx hash → step submitted
      Code->>Chain: re-ask at every ledger close
      Chain-->>Code: settled → next step, no click
    end
  end

  Code-->>User: completed: redeem e5e75d39…, deposit 86f5bc5c…, receipts on the card
```

## The exits, in the same order

| Instead of step | When | What the user sees |
|---|---|---|
| 10 | the model cannot tell what was meant (`clarify`) | one question, nothing else |
| 14–15 | a leg does not fit the reads, or would breach the floor | "Ruled out — …" with the figure (e.g. *only 59.5 XLM is spendable in the wallet*) |
| 18 | the RiskEngine preview says no | the option is removed, with the protocol's own sentence |
| 22 | the sealed plan no longer sizes on fresh reads | 409 with the reason — start a new investigation |
| 26 | live state fails the replay | back to proposed, nothing submitted |
| 29 | the RPC simulation refuses | "Not submitted — the protocol rejected this step", the run stops |

## What the model decides — and what it cannot

It decides **which reads** to make (step 6), **what the user meant** — intent, borrowing
permission, the floor, always anchored to the user's own words — and the **shape** of a plan:
ops from `WORKFLOW_OPS`, assets from the registry, sizing words from `PLAN_SIZINGS` (step 10).
It cannot choose an amount, a tool argument, a venue spelling or a rate. Everything from step 11
on would produce the same card if the model's JSON were typed by hand.

## Where it lives

| Steps | Files |
|---|---|
| 1–4 | `hooks/use-investigation.ts`, `app/api/copilot/investigate/route.ts`, `investigation/scope.ts`, `capacity.ts` |
| 5–11 | `investigation/flash.ts` (prompt), `decls.ts` (schema), `runtime.ts` (loop), `capabilities.ts` (reads), `decision.ts` (parser) |
| 12–20 | `strategy-reads.ts`, `plan.ts`, `sizing.ts`, `workflow/types.ts` (`OP_FLOW`), `workflow/allowlist.ts`, `simulate.ts`, `candidates.ts`, `answer.ts`, `continuation.ts` |
| 21–27 | `proposal.ts`, `workflow/risk.ts`, `workflow/journal.ts` |
| 28–34 | `execute.ts`, `hooks/use-workflow.ts`, MCP `vanna_earn_write`, `vanna_margin_trade`, `vanna_sign` |
