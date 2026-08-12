# Copilot Test Run — Open Items

**Branch:** `copilot-ui-rewire` · **Date:** 2026-08-12

Everything already fixed, verified, or passed this run has been dropped. This document
lists only what remains open, with severity, location, and a proposed fix for each.

---

## 1. Code Fixes Needed

| # | Issue | Severity | Location | Proposed Fix |
|---|-------|----------|----------|---------------|
| 1 | Single-leg deposit intermittently routes as `multi_leg` and errors. "deposit 5 XLM as collateral" failed once tagged `multi_leg`, then succeeded plain seconds later on the identical prompt. | Medium | `lib/copilot/router.ts` | Reproduce reliably, find which branch intermittently attaches `multi_leg: true` to a single-op deposit, and tighten that guard. |
| 2 | Multi-leg leveraged positions can skip the approval card. "open a 3x position with 50 BLUSDC" auto-executes the deposit leg immediately with no preview, because this phrasing hits `deposit_and_borrow`'s direct-execute + `pending_write.follow_up` chain — a second multi-leg mechanism separate from the `plan_preview`/freeze/approve flow that "deposit X and borrow Y at Nx" phrasing correctly uses for the identical trade. | High | `lib/copilot/handle.ts` (`deposit_and_borrow` branch) | Route single-clause leveraged-position phrasings through the same `tryMultiGoalPlan` / `coalesceLeveragedDepositBorrow` → `plan_preview` path instead of calling `runWrite` directly. |
| 3 | No server-side idempotency on writes. The same `approved_plan`, or an identical write request, sent twice both execute independently — confirmed with two concurrent "lend 1 XLM" calls producing two real tx hashes. The UI's Run button disables while loading, so a normal double-click can't trigger this, but a retry, a second tab, or a replayed request below the UI layer still can. | Medium | `lib/copilot/handle.ts`, `lib/copilot/plan-approval.ts` | Add a server-side idempotency key (hash of `plan_id` + step index, or a request nonce) checked before calling `executeMcpWrite`, instead of relying on client-side button state alone. |
| 4 | HostError #13 on a large BLUSDC borrow always reports "XLM is not ready in your wallet", regardless of which asset actually needs a trustline. | Low | `lib/copilot/mcp-write.ts` (`humanizeMcpWriteError`) | Add a `vanna_borrow` branch (every other write op already has one) that names the asset actually involved instead of falling through to the generic XLM-trustline message. |
| 5 | "borrow the max I can safely" asks which USDC variant before asking for a size. Safe (never auto-executes), but the wrong question first — no asset was named at all, yet `asset` defaults to `"USDC"` and triggers the variant-clarify before the size-ask. | Low | `lib/copilot/router.ts` | When no asset word appears anywhere in the message, ask for amount + asset together instead of defaulting to `"USDC"` first. |
| 6 | "when XLM hits $0.50 sell everything" and "what's the XLM/BTC pool" both fall to the generic capabilities blurb instead of a specific conditional / unsupported-asset refusal. Safe either way, just unhelpful. | Low | `lib/copilot/conditional-guard.ts` | Extend trigger words to catch "when X hits/reaches" (currently only "if"), and extend the unsupported-asset check to cover read-style questions naming an asset outside the supported set. |
| 7 | AQUA price lookup returns "oracle contract error" instead of "AQUA has no price feed". Root cause is in the external `vanna_mcp` repo — `oracle.py`'s `SYMBOL_CANONICALIZATION` / `LP_SYMBOLS` don't include AQUA. | Medium | `vanna_mcp` repo, `oracle.py` (external) | Needs a product decision first: should AQUA be priceable at all? If not, add it to the feed-less set so the error reads honestly instead of like an outage. |

---

## 2. External — Not Fixable From This Repo

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 1 | `vanna_borrow` rejects any BLUSDC amount above ~$5, with no diagnostic beyond "On-chain simulation rejected the transaction". Blocks any leveraged BLUSDC position. | Blocked | Ruled out pool liquidity, risk/HF gate, and flakiness. Needs MCP/backend logs to see the actual on-chain rejection reason. |
| 2 | Sign Service $1000/tx spend cap didn't hold once — a ~$1293 borrow auto-signed while a smaller ~$808 one was correctly capped moments later. | Not reproduced twice | Needs a Sign Service session-state audit, not a change in this repo. |

---

## 3. Housekeeping (No Urgency)

| # | Item | Action |
|---|------|--------|
| 1 | 66 dependabot vulnerabilities (32 high) on the default branch. | Schedule a dependency-upgrade pass. |
| 2 | `note.txt` §18's expected test count (778) is stale. | Update to 792. |

---

## 4. Still Needs Testing (Coverage Gap, Not a Known Bug)

| # | Area | Blocked By |
|---|------|------------|
| 1 | Sections 1–9 with auto-sign **OFF** | This pass ran almost entirely with auto-sign ON. |
| 2 | K-01–K-04 | Require the W3 thin/near-liquidation wallet — not authorised this session. |
| 3 | Z-01, Z-03–Z-06 (kill network, disconnect/switch wallet, `COPILOT_READS_ONLY`, wrong network) | Require capabilities this session didn't have (network throttling, a second wallet, an env-var restart). |
| 4 | S-08 (reject the wallet signature prompt) | Requires a Freighter-style external wallet — this account signs via an embedded Privy session key with no separate prompt to reject. |
