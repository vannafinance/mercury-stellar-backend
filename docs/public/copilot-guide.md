# Copilot User Guide

Vanna Copilot lets you manage your Vanna positions in plain English — check your health factor, lend idle USDC, open a leveraged farm, or swap and provide liquidity in one instruction — without leaving a chat window.

## Where to find it

Vanna has two chat surfaces. They look similar but do very different things:

| Surface | What it does |
|---|---|
| **Copilot** (`/copilot`) | The full product. Reads your live positions and can build, simulate, and execute real transactions on your connected wallet. |
| **Assistant** (sidebar, available on other pages) | Information only. Answers questions about the protocol and your positions but never builds or executes a transaction. |

If you want Copilot to actually *do* something — lend, borrow, swap, deposit — you need to be on the `/copilot` page with a wallet connected.

## Connecting a wallet

Copilot works with either:

- **An embedded Privy wallet** (created for you when you sign in) — supports both manual signing and auto-approve.
- **Freighter** (browser extension wallet) — every transaction is signed via the Freighter popup; auto-approve isn't available for Freighter, since Freighter's own extension has to confirm each signature.

## What you can ask (reads)

Anything that doesn't move funds runs instantly, with no signature and no confirmation step. Examples:

- "What's my health factor?"
- "How much can I borrow against my collateral?"
- "What's my current margin position?"
- "Show me all my positions" — margin, Earn, and farm positions together.
- "What's the USDC pool utilization / APR?"
- "What's the XLM price?"
- "Can I withdraw 50 XLM?"

Copilot answers these from live on-chain reads through the Vanna MCP server — it does not estimate or use stale cached numbers for anything position- or price-related.

## What you can do (writes)

Every action below builds a transaction, shows you a preview, and waits for a signature before anything reaches the chain:

- **Lend / Redeem** — deposit or withdraw from Vanna Earn (mints/burns vTokens).
- **Deposit / Withdraw collateral** — move collateral in or out of your margin account.
- **Borrow / Repay** — open or reduce margin debt.
- **Deposit and borrow** (single step) — deposit collateral and borrow against it atomically.
- **Swap** — trade one asset for another via Soroswap.
- **Add / Remove liquidity** — provide or withdraw liquidity on Aquarius or Soroswap.
- **Deploy to Blend** — Vanna's leveraged-yield flow: deposit collateral, borrow, and supply to Blend Capital in one instruction (e.g. *"farm 10 BLUSDC at 2x leverage on Blend"*).
- **Open / close a margin account.**

### Which USDC do you mean?

Vanna has more than one USDC-denominated pool — **BLUSDC** (Vanna's own margin/lending pool), **AQUSDC** (Aquarius), and **SOUSDC** (Soroswap) are economically distinct, even though they share one oracle price feed. If you say "USDC" without specifying, Copilot will ask you to pick which pool you mean via a small set of chips rather than guessing — guessing wrong here would mean depositing into, or borrowing from, the wrong pool entirely.

### Multi-step strategies

You can describe a strategy that spans more than one action, e.g. *"swap 100 XLM to AQUSDC, then add that to the Aquarius XLM/AQUSDC pool."* Copilot breaks this into an explicit, numbered plan — swap first, then add liquidity — and shows you both legs before anything executes. Legs run in order; if one leg fails, later legs don't execute and you're told exactly which step failed and why (see [Troubleshooting](#troubleshooting) below).

## How a transaction actually gets signed

Every write goes through the same pipeline before it touches the chain:

1. **Plan preview.** Copilot shows you exactly what it's about to do — asset, amount, direction, venue — before building anything.
2. **Risk simulation.** Your projected health factor after the action is calculated and shown. If the projected HF would fall below **1.00** (the point of liquidation) or below a floor you've stated (*"keep my HF above 1.4"*), the action is hard-blocked before a transaction is even built — this check happens in Copilot's own code, not by asking the model to be careful.
3. **Signing** — one of two paths:
   - **Manual signing (default):** Copilot returns the built, unsigned transaction to your wallet. You review and approve it yourself — a Freighter popup, or an in-app approval for an embedded Privy wallet. Nothing executes without this.
   - **Auto-approve (opt-in, Privy wallets only):** if you've turned this on, eligible actions are signed and submitted automatically by Vanna's Sign Service, without a per-action prompt. See below.
4. **Execution receipt.** Once submitted, Copilot shows you the result — success with a transaction hash, or a specific, plain-English reason if it was rejected.

## Auto-approve

Auto-approve lets you run a sequence of actions — or a multi-step strategy — without confirming each individual signature. It is **off by default**; the first time you sign in with a Privy wallet, Copilot tells you it's off and where to turn it on.

- **Turn it on** from the wallet menu ("Copilot auto-approve"). You'll be asked to set spend caps — a maximum per-transaction amount and a maximum per-day amount — before it activates.
- **What it actually authorizes:** a policy-bounded signing session held by Vanna's Sign Service (not the AI model). The session can only sign transactions calling a fixed allowlist of Vanna functions (deposit, borrow, repay, withdraw, swap, add/remove liquidity, and similar), against a fixed allowlist of contracts, and only up to your stated per-transaction and per-day caps. Anything outside that — a larger amount, an unlisted function, an unlisted contract — is refused by the Sign Service itself and falls back to asking you to sign manually. See [Security & Safety Model](./security.md) for the full guarantee.
- **Turn it off** any time from the same menu; the session is revoked immediately.
- Auto-approve is **per wallet address**, not global — switching wallets means setting it up again.

## Troubleshooting

Copilot translates raw errors into a specific, actionable reason rather than a generic failure. Common ones:

| Message | What it means |
|---|---|
| "projected HF … below safety floor …" | The action would push your health factor below 1.00, or below a floor you stated — lower the size, add collateral, or repay debt first. |
| "The Sign Service refused to sign this (policy: …)" | Auto-approve is on, but this specific transaction was outside your policy (over a spend cap, or an operation not on the auto-sign allowlist) — nothing was signed; sign it manually instead, or adjust your caps. |
| "Could not reach the Vanna MCP server (network)" | A connectivity issue between Copilot and the MCP server — check you're online and retry. |
| A step in a multi-step plan is marked failed, later steps skipped | Multi-step plans run in order and stop at the first failure — earlier steps that already succeeded are not rolled back, since they were separate, already-confirmed on-chain transactions. |

If Copilot asks you to clarify which asset or pool you meant, that's deliberate — it's the same "don't guess with your funds" principle described above.
