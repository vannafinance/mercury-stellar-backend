# Copilot test run — open items only

2026-08-12 · branch `copilot-ui-rewire`. Everything already fixed/verified/passed this run
has been dropped — this is just what's left to do.

## Needs a code fix

1. **Single-leg deposit sometimes routes as `multi_leg` and errors.**
   "deposit 5 XLM as collateral" failed once tagged `multi_leg`, then succeeded plain
   seconds later on the identical prompt. Not root-caused.
   **Fix:** reproduce reliably, find which `router.ts` branch is intermittently attaching
   `multi_leg: true` to a single-op deposit, and tighten that guard.

2. **Multi-leg leveraged positions can skip the approval card.**
   "open a 3x position with 50 BLUSDC" auto-executes the deposit leg immediately, no
   preview — because this phrasing hits `deposit_and_borrow`'s direct-execute +
   `pending_write.follow_up` chain in `handle.ts`, a second multi-leg mechanism separate
   from the `plan_preview`/freeze/approve flow that `X-08`-style phrasing ("deposit X and
   borrow Y at Nx") correctly uses for the identical trade.
   **Fix:** route single-clause leveraged-position phrasings through the same
   `tryMultiGoalPlan` / `coalesceLeveragedDepositBorrow` → `plan_preview` path instead of
   letting `handle.ts`'s `deposit_and_borrow` branch call `runWrite` directly.

3. **No server-side idempotency on writes.**
   The same `approved_plan`, or an identical write request, sent twice both execute
   independently — confirmed with two concurrent "lend 1 XLM" calls, two real tx hashes.
   The UI's Run button is `disabled` while loading so a normal double-click can't trigger
   this, but nothing stops a retry, a second tab, or a replayed request below that layer.
   **Fix:** add a server-side idempotency key (hash of `plan_id`+step index, or a request
   nonce) checked in `handle.ts`/`plan-approval.ts` before calling `executeMcpWrite`, not
   relying on client-side button state alone.

4. **HostError #13 on a large BLUSDC borrow always reports "XLM is not ready in your
   wallet"**, regardless of which asset actually needs a trustline.
   **Fix:** `mcp-write.ts`'s `humanizeMcpWriteError` has no branch for `vanna_borrow` (every
   other write op does) — add one that names the asset actually involved instead of falling
   through to the generic XLM-trustline message.

5. **"borrow the max I can safely" asks which USDC variant before asking for a size.**
   Safe (never auto-executes), but the wrong question first — no asset was named at all,
   yet `asset` defaults to `"USDC"` and triggers the variant-clarify before the size-ask.
   **Fix:** in `router.ts`, when no asset word appears anywhere in the message, ask for
   amount+asset together instead of defaulting to `"USDC"` first.

6. **"when XLM hits $0.50 sell everything" and "what's the XLM/BTC pool" fall to the
   generic capabilities blurb** instead of a specific conditional/unsupported-asset
   refusal. Safe either way, just unhelpful.
   **Fix:** extend `conditional-guard.ts`'s trigger words to catch "when X hits/reaches"
   (currently only "if"), and extend the unsupported-asset check to cover read-style
   questions naming an asset outside the supported set.

7. **AQUA price lookup returns "oracle contract error"** instead of "AQUA has no price
   feed" — root cause is in the external `vanna_mcp` repo (`oracle.py`'s
   `SYMBOL_CANONICALIZATION` / `LP_SYMBOLS` don't include AQUA), not this repo.
   **Fix:** needs a product decision first — is AQUA supposed to be priceable? If not, add
   it to the feed-less set there so the error reads honestly instead of like an outage.

## External / not fixable from this repo

- **`vanna_borrow` rejects any BLUSDC amount above ~$5** with no diagnostic beyond
  "On-chain simulation rejected the transaction" — blocks any leveraged BLUSDC position
  (X-03–X-05). Ruled out pool liquidity, risk/HF gate, and flakiness. Needs MCP/backend
  logs to see the actual on-chain rejection reason.
- **Sign Service $1000/tx spend cap didn't hold once** — a ~$1293 borrow auto-signed while
  a smaller ~$808 one was correctly capped moments later. Not reproduced a second time.
  Needs a Sign Service session-state audit, not a change here.

## Housekeeping (no urgency)

- 66 dependabot vulnerabilities (32 high) on the default branch — dependency-upgrade pass.
- `note.txt` §18's expected test count (778) is stale; it's 792 now.

## Still needs testing (coverage gap, not a known bug)

- Sections 1–9 with auto-sign **OFF** — this pass ran almost entirely with it ON.
- K-01–K-04 need the W3 thin/near-liquidation wallet — not authorised this session.
- Z-01/Z-03–06 (kill network, disconnect/switch wallet, `COPILOT_READS_ONLY`, wrong
  network) need capabilities this session didn't have (network throttling, a second
  wallet, an env-var restart).
- S-08 (reject the wallet signature prompt) needs a Freighter-style external wallet — this
  account signs via an embedded Privy session key with no separate prompt to reject.
