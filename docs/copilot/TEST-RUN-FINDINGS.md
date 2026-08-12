# Copilot Test Run — Open Items

**Branch:** `copilot-ui-rewire` · **Date:** 2026-08-12

Everything already fixed, verified, or passed this run has been dropped. This document
lists only what remains open, with severity, location, and a proposed fix for each.

---

## 1. Code Fixes Needed

| # | Issue | Severity | Location | Proposed Fix |
|---|-------|----------|----------|---------------|
| 1 | Single-leg deposit intermittently routes as `multi_leg` and errors. "deposit 5 XLM as collateral" failed once tagged `multi_leg`, then succeeded plain seconds later on the identical prompt. | Medium | `lib/copilot/router.ts` | Reproduce reliably, find which branch intermittently attaches `multi_leg: true` to a single-op deposit, and tighten that guard. |
| 2 | "borrow the max I can safely" asks which USDC variant before asking for a size. Safe (never auto-executes), but the wrong question first — no asset was named at all, yet `asset` defaults to `"USDC"` and triggers the variant-clarify before the size-ask. | Low | `lib/copilot/router.ts` | When no asset word appears anywhere in the message, ask for amount + asset together instead of defaulting to `"USDC"` first. |
| 3 | "when XLM hits $0.50 sell everything" and "what's the XLM/BTC pool" both fall to the generic capabilities blurb instead of a specific conditional / unsupported-asset refusal. Safe either way, just unhelpful. | Low | `lib/copilot/conditional-guard.ts` | Extend trigger words to catch "when X hits/reaches" (currently only "if"), and extend the unsupported-asset check to cover read-style questions naming an asset outside the supported set. |

---

## 2. External — Not Fixable From This Repo

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 1 | `vanna_borrow` rejects any BLUSDC amount above a low threshold (~$5, sometimes higher), with no diagnostic beyond a generic message. Blocks any leveraged BLUSDC position. | Open — narrowed | MCP server logs (`vanna-mcp-server`, Cloud Run) show the real on-chain failure is `HostError: Error(Contract, #13)` on the token transfer *into* the smart account during `borrow()` — the same class of error as the trustline issue fixed in §3.4 below, just not proven to be the identical cause. `is_borrow_precheck` returns `true` (the risk gate is not the blocker); Soroban SAC balances held by a *contract* have no classic trustline "limit" field, so the size-dependent threshold is still unexplained. Needs `vanna_core`'s token-contract source (not in this repo or `vanna_mcp`) or direct ledger-state inspection to pin down further. |
| 2 | ~~Sign Service $1000/tx spend cap didn't hold once~~ | **Resolved — was not a Sign Service bug** | Root-caused via `vanna-sign-service` Cloud Run logs: the Sign Service correctly rejected the over-cap borrow **twice** (`over_per_tx_cap`, confirmed in its own logs), but this repo's `mcp-write.ts` mapped that policy rejection to `needs_wallet_sign` with the XDR still attached, and the client's own embedded-session-key auto-approve signed and submitted it anyway — bypassing the Sign Service entirely. Fixed in §3 below; the Sign Service itself needed no change. |

---

## 3. Fixed This Pass (MCP / Sign Service root causes, requested separately)

| # | Issue | Fix | Repo | Status |
|---|-------|-----|------|--------|
| 1 | **Critical** — a genuine Sign Service policy rejection (`over_per_tx_cap`, `over_daily_cap`, `contract_not_allowlisted`, `function_not_allowlisted`, `session_expired`, ...) was staged as `needs_wallet_sign`, and the client's embedded-session-key auto-approve silently signed and submitted it anyway. | `executeMcpWrite` now recognises `auto_sign: "rejected"` with a genuine policy reason and returns `status: "rejected"` (→ `risk.decision: "block"`, no XDR attached) instead of falling through to the generic "stage for signature" path. | vanna-copilot-orchestrator | ✅ Fixed, tested (6 new unit tests), pushed to `copilot-ui-rewire`, PR [#57](https://github.com/vannafinance/mercury-stellar-backend/pull/57) |
| 2 | HostError #13 (trustline missing) on a borrow always reported "XLM is not ready in your wallet", regardless of which asset actually hit the error — `classifyTrustlineFailure` is itself asset-aware, but its only call site never passed an asset, so `readinessDisplayAsset(null)` defaulted to `"XLM"` every time. | `humanizeMcpWriteError` now takes an `{asset, trader}` context and threads `step.args.symbol` through to `classifyTrustlineFailure`. | vanna-copilot-orchestrator | ✅ Fixed, tested (3 new unit tests), pushed, same PR as above |
| 3 | AQUA (and any symbol with no oracle feed) surfaced as a generic `contract_error` reading like a transient outage ("the price for AQUA is currently unavailable due to an oracle contract error") — `oracle.py`'s own exception message ("Oracle: price not found for symbol 'AQUA'") was already specific, but `error_handling.py`'s `tool_safe` flattened every `ContractCallError` into the same generic bucket regardless of message. | Added a `reason: "no_price_feed"` case matched on the wrapper's own message shape (not a per-symbol allowlist, so it stays correct if a symbol gains/loses a feed) — message now says plainly "X has no price feed on this oracle deployment... not transient, retrying will not help." | `vanna_mcp` (mercury-stellar-backend) | ✅ Fixed, tested (1 new unit test passing, full suite otherwise green besides 2 pre-existing unrelated failures — see below). **Committed locally on `main`, not pushed** — only the copilot repo's push/PR was requested; say if you want this pushed too. |
| 4 | Multi-leg leveraged positions could skip the approval card. "open a 3x position with 50 BLUSDC" auto-executed the deposit leg immediately with no preview — this phrasing hit `deposit_and_borrow`'s direct-execute + `pending_write.follow_up` chain, a second multi-leg mechanism separate from the `plan_preview`/freeze/approve flow that "deposit X and borrow Y at Nx" correctly used for the identical trade. | Both the `deposit_and_borrow` and leveraged `deploy_to_blend`/`supply_to_blend` handlers now build their steps and call a shared `freezeLeveragedPlanPreview` helper, which routes through the same freeze/fingerprint/approve flow as every other multi-leg plan, instead of calling `runWrite` directly on leg 1. | vanna-copilot-orchestrator | ✅ Fixed, tested, verified live end-to-end (preview card shown → approved → both legs executed), pushed to `copilot-ui-rewire` |
| 5 | No server-side idempotency on writes. The same `approved_plan`, or an identical write request, sent twice both executed independently — confirmed with two concurrent "lend 1 XLM" calls producing two real tx hashes. The UI's Run button disables while loading, so a normal double-click couldn't trigger this, but a retry, a second tab, or a replayed request below the UI layer still could. | New `write-dedupe.ts` claims a `trader+op+asset+amount` key (writes) or the `plan_id` (approved plans) for 8s; a repeat within that window is refused with "I won't submit it twice" instead of executing again. | vanna-copilot-orchestrator | ✅ Fixed, tested, verified live (two concurrent "lend 1 XLM" calls → first executed on-chain, second refused as duplicate), pushed to `copilot-ui-rewire` |

**Pre-existing, unrelated to this pass:** `vanna_mcp`'s working tree already had uncommitted changes to `mcp_server/tools/sign_tools.py`, `mcp_server/tools/borrow_tools.py`, and a deleted `ALLOWLIST_FIX_PLAN.md` before this session touched the repo — left untouched. Two tests in `tests/test_mcp_sign_tools.py` (`test_enable_auto_sign_success_forwards_and_summarizes`, `test_enable_auto_sign_forwards_optional_caps_and_expiry`) fail against that uncommitted state (an in-progress `function_allowlist` change), unrelated to anything in this document.

---

## 4. Housekeeping (No Urgency)

| # | Item | Action |
|---|------|--------|
| 1 | 66 dependabot vulnerabilities (32 high) on the default branch. | Schedule a dependency-upgrade pass. |
| 2 | `note.txt` §18's expected test count (778) is stale. | Update to 809. |

---

## 5. Still Needs Testing (Coverage Gap, Not a Known Bug)

| # | Area | Blocked By |
|---|------|------------|
| 1 | Sections 1–9 with auto-sign **OFF** | This pass ran almost entirely with auto-sign ON. |
| 2 | K-01–K-04 | Require the W3 thin/near-liquidation wallet — not authorised this session. |
| 3 | Z-01, Z-03–Z-06 (kill network, disconnect/switch wallet, `COPILOT_READS_ONLY`, wrong network) | Require capabilities this session didn't have (network throttling, a second wallet, an env-var restart). |
| 4 | S-08 (reject the wallet signature prompt) | Requires a Freighter-style external wallet — this account signs via an embedded Privy session key with no separate prompt to reject. |
