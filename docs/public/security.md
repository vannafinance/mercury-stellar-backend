# Security & Safety Model

Two separate guarantees are worth pulling apart, because they're enforced by two different pieces of code: **"the AI can't move your funds by itself,"** and **"even when signing is delegated, it can't move more than you allowed."**

## The AI never holds a key

Every write tool on the Vanna MCP server returns an **unsigned** transaction. Nothing about the language model's reasoning path ever touches a private key. Signing happens in exactly one of two places:

1. **Your own wallet** — Freighter's extension, or an embedded Privy wallet's in-app approval. This is the default, and the only path available at all for Freighter users.
2. **Vanna's Sign Service** — a separate service, not the AI, holding a server-side Privy signer — but only for wallets that have explicitly opted into a policy-bounded auto-sign session (see below), and only within that policy.

Admin-level contract functions (`deploy`, `upgrade`, `set_admin`, `pause`, `set_risk_parameters`, and similar) are never exposed as callable tools at all — not gated behind a permission check, simply absent from the tool surface entirely.

## Guardrails before a transaction is even built

Before Copilot (or any client) builds a write, Vanna's deterministic code — not the model — checks:

- **Health factor.** A hard floor of **1.00** (the liquidation threshold) blocks any action projected to cross it, plus any user-stated floor above that (*"keep my HF above 1.4"*). This simulation runs against real on-chain state before a transaction exists, not after.
- **Collateral allowlist.** Read live from the Registry-resolved contract, not cached client-side — an asset that stops being collateral-eligible on-chain stops being offered immediately.
- **Preflight reads.** `can_borrow`, `can_withdraw`, and similar checks tell you *why* an action would fail before anything is built, using the same RiskEngine the on-chain transaction will itself be checked against — a client-side "no" and an on-chain "no" come from the same source of truth.

An action that fails one of these checks is rejected before a signature is ever requested, from either you or the Sign Service.

## Delegated auto-sign: what it actually authorizes

Turning on auto-approve does **not** hand the AI your key, and does not mean "sign anything." It creates a session at the Sign Service, independently policed by a pure, unit-tested policy engine that is the actual security boundary between "auto-sign is on" and "funds move":

- **Contract allowlist.** Only a fixed set of verified contracts — the AccountManager, Vanna's own lending pools, the Blend router, the Aquarius router — decoded directly from the transaction's own XDR. The policy never trusts a caller's claim about which contract a transaction targets.
- **Function allowlist.** Only specific functions: `create_account`, `deposit_collateral`, `withdraw_collateral`, `borrow`, `repay`, `deposit`, `redeem_vtokens`, `execute`, and the atomic `deposit_and_borrow*` variants. **`close_account`, `settle_account`, and `liquidate` are deliberately excluded** — they don't carry one clean priced amount a spend cap can evaluate against, so they always require your own signature, auto-sign session or not.
- **Spend caps.** A per-transaction cap and a per-day cap, in the amount you set when you turned auto-approve on (defaulting to a modest cap if you don't customize it). The amount is decoded from the transaction's own call arguments — again, not taken on trust from the caller. Daily spend is tracked atomically (reserve-then-settle under a database lock), so two transactions racing against the same daily cap can't both slip through.
- **Anything outside this policy is refused, not silently downsized.** A rejected auto-sign attempt returns a specific reason (an over-cap amount, a function or contract not on the allowlist, a session-identity mismatch) and nothing is signed — Copilot then offers you the same transaction for manual signing instead.

You can revoke an auto-sign session at any time; revocation takes effect immediately and there is no way to sign against a revoked session.

> **Testnet note:** spend caps are currently enforced as a flat token-amount stand-in, not a live oracle-priced USD figure — testnet tokens have no real USD value, so "$1000" on testnet is a notional cap on token units, not a guarantee of real-dollar exposure. True oracle-priced USD capping is planned before any mainnet deployment; don't treat testnet caps as a preview of mainnet dollar limits.

## Identity: who a transaction is really for

On deployments with identity enforcement turned on, every write is checked against a **wallet-binding** record before it's allowed to proceed — the wallet a transaction acts on has to be verifiably bound to the identity making the call, not just asserted. An unbound wallet is rejected with a specific `wallet_not_bound` error and directed to the wallet-connect flow, rather than allowed to proceed against a wallet it doesn't actually control.

## In short

| Question | Answer |
|---|---|
| Can the AI sign a transaction on its own? | No — every write tool returns unsigned XDR; something outside the model's reasoning always signs. |
| What signs it, then? | Your own wallet by default; optionally a policy-bounded Sign Service session you explicitly opted into. |
| Can auto-sign call anything? | No — a fixed contract allowlist, a fixed function allowlist, and your own spend caps, checked against the transaction's actual decoded contents. |
| What can never be auto-signed? | Account closure, account settlement, and liquidation — always a manual signature. |
| What stops an unsafe trade before it's even built? | Deterministic health-factor and collateral-allowlist checks, run against live on-chain state, independent of the model. |
