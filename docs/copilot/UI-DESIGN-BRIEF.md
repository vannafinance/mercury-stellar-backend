# Copilot UI — design brief

Paste the block in §7 into Claude Design. Everything above it is the reasoning, so the brief
can be argued with rather than followed blindly.

---

## 1. What this screen is

One page where someone states a money goal in their own words and gets back either an answer,
a set of options, or a plan to approve. It is not a chat toy and not a dashboard: every card
ends in either a fact or a decision.

The person using it owns the account. They are not a developer, and nothing on screen should
require them to know how the system is built.

## 2. Words to remove, and what replaces them

These appear on screen today. Every one leaks implementation.

| On screen now | Replace with |
|---|---|
| `AGENT-NATIVE · ORCHESTRATOR` | nothing — delete the eyebrow entirely |
| `Enable auto-sign (MCP defaults)` | *Approve once, then let it run* |
| `auto-sign` / `session signing` | *approve automatically* |
| `SESSION LOG`, `22 turns` | *History* |
| `STRATEGY` / `READ` / `WRITE` / `TURN` chips | *Plan* / *Question* / *Transaction* |
| `router`, `multi_leg`, `vanna_deposit_collateral` | the human step name only; the tool name belongs in a details drawer |
| `tool call and outcome` | *what it did* |
| `investigation`, `continuation`, `proposal` | *checking*, *this conversation*, *plan* |
| `Checked in 26s · 26s this device` | *Checked just now* (hover for timing) |
| `unsigned XDR`, `preflight`, `policy` | never shown; failures say what to do instead |

**Rule for the designer:** if a word would not appear in a sentence spoken to a customer at a
bank, it does not belong on the surface. Technical detail is welcome behind a disclosure, never
in the default view.

## 3. The account panel — the dial, and what sits under it

This is the part the person looks at before and after every action, so it carries the most
weight.

**Today:** a half gauge showing `1.10` on the left, `3.0+` on the right, a needle, the number
`2.64` in monospace, and three lines of small print — *"includes unposted · risk engine uses
posted (unsafe at 1.10)"* and *"your floor 1.15"*.

**Problems with it:** the scale is unlabelled so `3.0+` is meaningless to a newcomer; the
liquidation line is a tick rather than a boundary you can feel; the caveat about posted vs
unposted is true and important but reads as noise; and collateral/borrowed sit below as bare
progress bars with no relationship to the dial.

**What the redesign must convey, in priority order:**

1. **Am I safe?** — the distance between where I am and **1.10**, where the position is
   liquidated. That distance is the whole point of the dial. Liquidation is not a tick mark on
   a scale; it is a wall, and the design should feel like one.
2. **What is that number made of?** — collateral and borrowed, as amounts, directly beneath,
   visually connected to the dial rather than stacked underneath it as unrelated bars. The
   health factor IS collateral ÷ debt; the layout should make that legible without a formula.
3. **My own limit, if I set one** — the floor the person asked for, shown on the same scale as
   a second marker, clearly distinct from the liquidation line.

**Two constraints that are not negotiable, because they are protocol facts:**

- **1.10 is liquidation.** At or below it the position can be liquidated. Never render 1.10 as
  "caution" or amber-safe — it is the failure boundary.
- **Two collateral figures legitimately differ.** Tokens sitting in the margin account that are
  not posted as collateral count toward the page figure but not toward what the liquidation
  engine sees. The design needs an honest way to show one number and reveal the other on
  demand, without implying either is wrong.

Do not invent a "days until liquidation" or a risk score. Nothing on the page may imply a
prediction; every number shown is read from the chain.

## 4. Auto-approve — a control, not a card

**Today:** a full-width card titled *Autonomy* with a toggle, a status word (`manual signing`),
and two sentences of explanation always visible. It takes as much room as the account panel and
is read once.

**Wanted:** a single small toggle in the page header or beside the composer, with its state
legible at a glance (on / off), and the explanation on hover or tap rather than permanently on
screen.

The tooltip should say, in plain words, what changes:

> **Off** — every transaction asks you to sign it.
> **On** — you approve a plan once and its steps run without asking again, up to the limits you
> set.

And it must surface, without jargon, the two states where it cannot be turned on:
- no embedded wallet available on this account
- the signing service is unreachable

Both today render as *"Needs a Privy embedded wallet — tap for why"* and
*"unavailable (forbidden)"*. Neither means anything to the person reading it.

**One caution for the designer:** this toggle changes whether money can move without a further
prompt. Small is right; invisible is not. It needs a clear on-state, and turning it *on* should
take a deliberate action rather than a stray tap.

## 5. Cards — the four kinds

Every response is one of four. They should be visibly different at a glance.

1. **Answer** — a fact and the numbers behind it. *"Your health factor is 2.64."*
2. **Options** — a recommendation first, with its reason, then the alternatives ranked, each
   with its rate and size. The reason must name the binding constraint, e.g. *"AQUSDC pays 11.2%
   more but the swap costs more than it gains over 30 days."*
3. **Plan for approval** — the steps in order with real amounts, the projected health factor
   against 1.10, and one primary action. The button says **Sign** — not "Sign with wallet",
   because when approve-automatically is on the wallet is not what signs.
4. **Result** — what settled, with a link to the transaction, and what changed.

A failure is not a fifth kind. It is whichever card it would have been, with the reason in
place of the result, and a next step the person can actually take.

## 6. History

A list of past turns, newest first, each one line: what was asked, what happened, when. Expanding
one shows the card it produced. No status vocabulary beyond *answered*, *done*, *stopped*,
*not finished*.

## 7. The brief to paste

> Design a single-page interface for a personal finance copilot on a lending and margin protocol.
> The user types a goal in plain English and gets back an answer, a set of ranked options, or a
> plan they approve before anything moves.
>
> **Audience:** the account owner. Not technical. No jargon anywhere — no "agent", "session",
> "tool", "orchestrator", "sign XDR", "MCP". If a word would not be said to a customer at a bank,
> it does not appear.
>
> **Screen holds, in this order:**
>
> 1. A title and a single input line: *"Ask, or state an action…"* with a Run button.
> 2. The conversation — stacked cards, newest at the bottom, of four kinds: an **answer** (a fact
>    and its numbers), **options** (one recommendation with its reason, then ranked alternatives
>    with rate and amount), a **plan to approve** (ordered steps with real amounts, the projected
>    health factor, one primary button labelled **Sign**), and a **result** (what settled, with a
>    transaction link).
> 3. An **account panel**: a health-factor dial whose most important job is showing the distance
>    between the current value and **1.10**, the level at which the position is liquidated —
>    render that as a hard boundary, not a tick on a scale. Directly beneath and visually
>    connected to it, the collateral amount and the borrowed amount that the figure is made of.
>    If the user has set their own minimum, show it as a second, clearly different marker.
> 4. A **history** list: one line per past request — what was asked, what happened, when.
>
> **A small toggle** in the header labelled *Approve automatically*, with its state obvious at a
> glance and an explanation on hover: off means every transaction asks you to sign; on means you
> approve a plan once and its steps run within limits you set. It must also show, in plain words,
> when it cannot be switched on. Turning it on should require a deliberate action.
>
> **Rules:** never show a countdown, a risk score, or a prediction — every number is read live
> from the blockchain. Two collateral figures can legitimately differ; show one and let the user
> reveal the other rather than hiding the difference. Dark interface. Restrained colour: reserve
> the strongest accent for the single primary action on screen, and use one unmistakable colour
> for the liquidation boundary and nothing else.
>
> Show the page in three states: an answer, a set of options, and a plan awaiting approval.
