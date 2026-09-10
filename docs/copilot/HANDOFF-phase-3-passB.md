# Handoff — Phase 3 Pass B: deploy, decide the collateral definition, then cut the planner

**For:** the implementer (Grok 4.6). **Audited by:** Claude. **Created:** 10 Sep 2026.
**Branch:** `copilot-upgrade`.
**Baseline (verified, not taken on trust):** `tsc --noEmit` **clean** · `npx vitest run` = **1,580 passed / 0 failed / 3 skipped** · MCP pytest 61 passed.

**Test account for everything below** — the owner's local signed-in wallet:
`CBOQAN5NFII4P5HD73M2IRSFYZSXC5XC76FQWQ5JU7LJAO66TFFPG5XY`
(Google Wallet `GD4BQR…NPDH` → Margin Account `CBOQAN…G5XY`, Stellar Testnet.)
Use this one, not `CAHLZ…GLLJ`, for live checks from here on.

**Both repos in scope.** App: `vanna-copilot-orchestrator`. MCP: `C:\Users\akgam\Documents\vanna_mcp`.
**Never deploy contracts.** MCP and Sign Service deploys are authorised (see Task 2).

---

## 0. How to report back — same format, every time

```
## Summary

**Done** / **Verified** / **Not done or deferred** / **Deviations** / **New findings**
**Suite:** tsc <…> · vitest <p>/<f>/<s> (baseline 1580/0/3) · pytest <…>
```

Report failures as failures. Name the repo per change. If a hypothesis here is wrong, say
which and what the real cause was.

---

## Pass A was excellent work — and it found something bigger than the task

The reconciliation is exactly what was asked for, and the record
(`docs/copilot/phase-3-liquidation-reconcile.json`) is honest about its own limits, including
`sameLedger: false`. Both deviations were right: the drift tolerance needed concrete numbers,
and the simulate fallback keeps sizing off the app snapshot while MCP is undeployed. The
seed-timestamp fix landed. Suite 1,570 → 1,580.

**Then the numbers came back and reframed the phase.**

---

## Task 1 — The collateral definitions differ, and users see the friendlier one

On the bound account, **debt agrees to four decimal places** ($1,650.0908 app vs $1,650.0907
contract) while **collateral differs by $1,032.72 (~25%)**. Debt agreeing that precisely rules
out ledger drift — these reads are effectively simultaneous. This is not noise, and it is not
the Phase 2.7 bug in reverse.

**The cause is in `lib/account-snapshot.ts:384`:**

```ts
let grossCollateralValue = farmPositionValue + rawAssetValue + nonSacCollateralValue;
```

The app adds **`rawAssetValue`** — raw wallet holdings. The contract's
`get_current_total_balance` counts recorded collateral plus Blend receipts, i.e. only what is
actually **posted**. Both figures are internally correct; they answer different questions.

| | Collateral | Debt | Health factor |
|---|---|---|---|
| App (Margin page, copilot display) | $4,083.87 | $1,650.09 | **2.47** |
| Contract (`liquidation_snapshot`) | $3,051.15 | $1,650.09 | **1.85** |

**The consequence is a product decision, not a copilot one:** the health factor users read is
about 33% safer than the one the liquidation engine computes. Tokens sitting in a wallet do
not back a loan. A user at a true 1.85 who believes they are at 2.47 will borrow more than
they should, and the copilot's own floor logic inherits the same optimism.

**Do:**

1. **Do not change the app's collateral maths in this phase.** It is load-bearing for the
   Margin page and Portfolio, and changing it silently would move numbers under users.
2. **Raise it with the app/product owner** with these figures. The question for them: should
   "health factor" mean *posted collateral / debt* (what liquidates you) or *total net
   position / debt* (what the page shows today)? Only one of those can be labelled "health
   factor" without misleading.
3. **Keep Pass A's behaviour meanwhile** — refuse to quote a sized borrow when the sources
   disagree, keep displaying the page's figure. That is the right conservative default.
4. **Add the explanation to the refusal.** Today the card says the sources disagree. It should
   say *why*: "your wallet holdings count toward the figure shown on the Margin page but not
   toward what the liquidation engine sees." A user who understands the gap can act on it.

---

## Task 2 — Deploy MCP so `liquidation_snapshot` is live

Pass A built the audited read and verified it locally; live MCP still answers **unknown
action**, so sizing is running on the simulate fallback. That fallback is a good stopgap and a
bad steady state — it bypasses the audited tool path the whole catalogue design depends on.

**Authorised: deploy MCP and the Sign Service. Never deploy contracts.**

`cloudbuild.yaml` in `vanna_mcp` builds and deploys both services to project `vanna-mcp` via
`gcloud run deploy --image …:$COMMIT_SHA`. Submit the build, then verify against the live
endpoint rather than assuming:

- `vanna_margin_status` action `liquidation_snapshot` returns the 3-tuple on
  `CBOQAN…G5XY`.
- The app's catalogue path (not the fallback) is the one being exercised — log which path
  served the read.
- Re-run the reconciliation **ledger-pinned this time**: all reads at one ledger, so the
  remaining gap is definitively the `rawAssetValue` definition and nothing else.

---

## Task 3 — Auto-approve is on with caps the Sign Service is not enforcing

The UI now reads: **"Budget set — in-app only · $1000/tx · $1000/day · not enforced by the
Sign Service"**, from `copilot-workspace.tsx:6317`. That honest indicator is a good addition.
What it is telling us is not good: **auto-approve is ON and the caps are client-side only.**

A cap enforced in the browser or the Next.js process is a cap that can be bypassed by calling
the API directly. Blueprint §7 says caps belong to MCP and the Sign Service precisely so this
cannot happen.

- Establish why `capsEnforced` is false — is the Sign Service session not established, is the
  policy not set for this subject, or is the app simply unable to confirm?
- If the Sign Service genuinely is not enforcing, **auto-approve should refuse to arm**, not
  arm with a warning. An unenforced cap on an armed autonomous signer is the wrong default.
- If it is enforcing and the app cannot tell, fix the confirmation — a false "in-app only" is
  its own problem, because it trains people to ignore the warning.

---

## Task 4 — Pass B: one planner

Now unblocked, and the eval gate is in place.

- **`router.ts` (2,615 lines) → read-through cache.** Exact-match reads only, returning early,
  **no authority to override a researched plan**. `fast-path.ts` is the right shape; extend it
  and retire the rest.
- **`handle.ts` (8,642 lines) → approval replay, write execution, settlement verification and
  receipts.** Target ~2,000 lines.
- **Delete `shouldUseLegacyExecutor` and its two references** in `copilot-workspace.tsx`. It
  already returns a hard `false`; a dead gate that looks live is a trap.

**Move one decision path at a time and run the eval suite between moves.** A single
6,000-line deletion that fails the gate tells you nothing about which move broke it.

**Keep untouched:** resume and multi-leg execution, the trust boundary, `usable-read.ts`
semantics, the binding rules in blueprint §7, and Pass A's drift guard.

---

## Task 5 — Live verification, on `CBOQAN…G5XY`

Still needs the signed-in browser:

1. **Latency** — capture the `logPhase` breakdown for a strategy turn; name the dominant cost.
   Targets: strategy < 15s, account question < 5s.
2. **`can_withdraw` produces a fact** on the card, with no "no supported display fields".
3. **Five runs of the flagship prompt, auto-approve ON and again OFF.** Different code paths,
   different failure histories.

---

## Acceptance

1. The collateral-definition finding is raised with the app owner, with figures.
2. The refusal card explains *why* the sources disagree, not just that they do.
3. MCP is deployed; `liquidation_snapshot` answers live; the catalogue path serves it, not the
   fallback.
4. A **ledger-pinned** reconciliation is recorded on `CBOQAN…G5XY`.
5. `capsEnforced` is either true, or auto-approve refuses to arm.
6. `router.ts` cannot override a researched plan; `handle.ts` materially smaller; eval green.
7. `shouldUseLegacyExecutor` and its references are gone.
8. `tsc` clean; vitest ≥ 1,580/0/3; MCP pytest green.

---

## Then — MCP blueprint M2

The read/write split. `vanna_margin_trade` currently dispatches `can_withdraw` **and**
`borrow`/`repay`/`settle` through one tool, so the read-only guarantee lives in the app's
catalogue rather than in the server. Not exploitable today — the server is authenticated and
our app is its only caller — but it is the gate on ever exposing the MCP server publicly, and
it nearly went wrong once already when a catalogue "alignment" would have pointed the model at
the write dispatcher.
