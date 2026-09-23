# LIVE HANDOFF: copilot fix pass (updated after every step)

**Any agent (Claude, Grok, Codex): read this first, then `docs/copilot/FIX-LIST-copilot-upgrade.md`
(the full per-fix record, bottom sections are newest).** This file is the current state only.
Older handoffs: `HANDOFF-2026-09-23-grok.md` (Grok's pass), `SESSION-HANDOFF.md` (11 Sep history).

_Last updated: 23 Sep 2026, ~20:15 local, by Claude (session 2efb4a37)._

---

## 1. Where things are

| | |
|---|---|
| App repo | `C:/Users/akgam/Documents/vanna-copilot-orchestrator`, branch `try/investigate-first`, HEAD `b9df5f3` (checkpoint #13, local, not pushed) |
| Pushed | `copilot-upgrade` = `036da72`. PR #99 (copilot-upgrade → dev) **merged** 08:21 UTC 23 Sep, so the deployed dev site runs investigate-first. |
| Committed locally | Checkpoints: #1 `2a6cf30` (all fixes in §3), #2 `d0ff53d` (H), #3 `a4bf10d` (J1 LP-refresh log), #4 `542fd78` (J2 partial-run heading), #5 `0871f50` (J5 bare USDC), #6 `c81255a` (J6 AQUA reason), #7 `e483782` (K test audit dir), #8 `d624432` (evidence keeps plan-required reads), #9 `fac865e` (fixed options only for named assets), #10 `aa15e4d` (amount anchored from the user's own earlier words), #11 `0e8d8da` (answer before idle list), #12 `e7abae3` (ask which USDC first), #13 `b9df5f3` (dev-only diagnostics file). Earlier text: #1 every fix in §3 (code and tests). **Not pushed, not deployed.** Docs remain uncommitted by rule. Revert one fix = `git revert` its checkpoint. |
| MCP repo | `C:/Users/akgam/Documents/vanna_mcp`, main at `8d98ec6` (Grok's Soroswap fee fix), deployed as `vanna-mcp-server-00106-rwj`. |
| Baseline worktree | `C:/Users/akgam/Documents/vco-baseline` = detached `036da72`, `node_modules` junctioned. Use it for "without my change" test runs. **Never stash or checkout in the main tree.** |
| Dev server | Aditya runs `npm run dev` on :3000. Browser (DevTools-controlled Chrome) at `localhost:3000/copilot`, wallet `GDW3B2…VJ52`. |

## 2. Rules (Aditya's, all standing)

1. **No hardcoded fixes or phrasing:** no keyword lists, per-symbol cases, regexes over wording, or prompt tweaks. Fix the mechanism (OP_FLOW, registry, structured fields with `sourceQuote` anchored to the user's words) and prove it on an un-enumerated input.
2. **Don't disturb what works.** Per fix: run only that fix's tests, plus the suites it touches **compared against the baseline worktree** (same failures = no regression). Full suite ONCE at the very end.
3. **Checkpoint every build:** one local commit per fix, once its checks pass. Message: one short line, Aditya's name only, **no attribution**. **Never push, never open a PR** unless told. Docs stay uncommitted.
4. **dev is read-only.** Work reaches dev only via a PR from `copilot-upgrade` that Aditya merges. Before any push or PR: `git fetch`, `git merge-tree`, and report conflicts.
5. **DO NOT TOUCH SWAP CODE** (another dev's explicit instruction): swap quoting/floors, swap hand-offs, swap cards, swap execution.
6. **Other devs' cards:** never change their CONTENT (e.g. swap cards). Layout may change; report it. Check `git blame` before touching a card.
6. **Dev server:** never kill or restart it; Aditya restarts. After a restart, remind him to delete `.next`. Don't edit code while a background vitest run is going (it caused "no tests" load failures).
7. **Verify, never relay:** re-check every claim (yours, another agent's, a memory) against code or live data before stating it.
8. Multi-leg plans need approve-and-run. Single leg runs directly only with auto-approve ON. User's own "I accept the loss" → execute.
9. Explain in plain words: what it fixes, for which prompts, what it won't touch. Short.
10. **Update this file after every step.**
11. **Write Windows paths with FORWARD slashes in any repo file.** Tailwind v4 scans docs; a backslash before the session id (backslash + 2efb4a) in a path broke the CSS build ("Invalid code point 3078986" = 0x2EFB4A).

## 3. Done this pass (in checkpoint #1 `2a6cf30`, tests pass, baseline-compared)

| Fix | What | Key files | Tests |
|---|---|---|---|
| Wallet reserve (XS7) | "keep 100 XLM liquid" binds every sizer; **verified live** | floor.ts, candidates.ts (`holdingsAfterReserves`), plan.ts, service.ts, proposal.ts, decls.ts, decision.ts | wallet-reserves |
| Withdraw-all total (X12) | `valueMovedWad` counts each step once | plan.ts | plan-value-moved |
| APY | Earn as-is, Blend weekly-compounded, per-leg weighting; reply AND card say APY | apy.ts, candidates.ts, plan.ts, answer.ts, investigation-card.tsx (owner-approved) | plan-apy, investigation-answer, investigation-card-options |
| Scroll | Page scrollbar; latest message pinned on send (MutationObserver on bubbles) | copilot-shell.tsx, chat-message.tsx | copilot-shell-scroll. **Owner's live check still pending.** |
| Stale carried reads ("aquarius lp") | Reuse only if still fresh at loop end | service.ts, runtime.ts (`boundedLimits` exported) | investigation-diagnostics |
| Diagnostics | Hidden `view.diagnostics`: stopReason/stopDetail, droppedPlanReasons, failedReads | decision.ts, runtime.ts, service.ts, view.ts, types.ts | investigation-diagnostics |
| Abort labels | Every abort passes a reason; `[copilot] investigation aborted {reason}` | use-investigation.ts, copilot-workspace.tsx | logging only |
| Exit-only wording | Pure withdrawals get no "idle funds / supply rate" sentence | answer.ts | investigation-answer |
| Blend exit label | `verbOf` skips pocket words: "Withdraw 181.9 BLUSDC" | plan.ts | plan suites |
| A. Farm $0.00 | LP exit valued from the pool read (`lpExitUsd`) | plan.ts, strategy-reads.ts | lp-exit-value |
| C. Repay > debt | `withinPosition` when a repay fits its own token's debt read | sizing.ts, plan.ts | repay-all-debts |
| G. Missing deposit | Account-spending op sized from idle → deposit + op (owner-approved) | plan.ts `expandLegs` | idle-into-account-ops; plan-resolve row removed |
| B. Join parts (≤ 8 steps) | `goal.planRelation` = parts (quoted) → one plan; else fallback to exact old options | types/decls/decision.ts, floor.ts, plan.ts (`joinPlanParts`, `resolveJoinedOrParts`), service.ts, journal.ts (`MAX_WORKFLOW_STEPS`) | plan-parts-join (9); same failures as baseline |

**Other agents' work in this tree (keep as written):**
- **Codex:** answer.ts "this plan includes borrowing" wording; proposal.ts `assertDebtIntentAgrees` (routeMessage, both propose paths).
- **Grok:** MCP `8d98ec6` (deployed).

**Known baseline failures (NOT regressions):** investigation-plans-e2e (2, the ranker; Grok question 1), plan-shape-matrix lend (2), remove-liquidity-multi-leg-unwind (2), unsized-lp-input (1).

## 4. Next steps, in order

0. **LIVE TEST RUN IN PROGRESS** (owner driving prompts #1–13 from the list in chat; results logged at the bottom of FIX-LIST). Fixed from it: #8 evidence sealing, #9 options for unnamed assets, #10 accept-the-loss amount. Done: answer first (#11), ask which USDC first (#12). Diagnostics file done (#13): `.local/copilot-diagnostics/<day>.jsonl`. NEXT: owner re-runs #12 and #13, then read the file and fix D/E.

1. ~~Checkpoint #1~~ done (`2a6cf30`). From now on: one checkpoint commit per fix.
2. **Staged approvals** for X12: design in `DESIGN-staged-approvals.md`, 2 open questions for Aditya. Build only after he answers.
3. ~~H~~ done (checkpoint #2): a borrow or withdraw after deposits is previewed against the current account.
4. ~~I~~ analysed: not a bug. The card needs "HF before → after" on the contract basis (UI pass).
5. **J (IN PROGRESS).** Done: J1 LP-refresh log, J2 partial-run heading. Dropped: guardian-floor fallback (owner: asking for the floor on X11 is correct). J5 bare USDC done (checkpoint #5). Dropped: both X5 items (swap code is off limits). Left: ~~AQUA~~ done (#6); "available capabilities" message (UI pass wording); G1 "USDC pool stats" is a read question (answer path; not covered by J5).
6. ~~K~~ done (#7): tests write the audit log to a temp folder.
7. **D/E:** wait for live `diagnostics` (droppedPlanReasons / failedReads). Suspect for D: remove_liquidity carrying `assetOut`.
8. **UI pass** (last): UI-FIX-LIST 21–22 layout and structured replies, card "HF before → after", the question quoting "APR", stale notes, humanizer research.

## 5. Waiting on Aditya

- **Swaps:** J5 (bare USDC in a swap asks which) and G (a swap sized from idle gets a deposit) affect swap requests indirectly. Keep, or exclude swaps by mechanism?

- **Grok's 2 questions (parked):** the ranker hiding no-debt plans; one "2x" across two assets.
- **Cancel button** where Send was (fix 9 hypothesis). Confirm from the abort-reason log first.
- **Staged approvals:** the 2 open questions in the design doc.
- **Live checks:** scroll, then re-run X12 and XS6 after B.

## 6. Commands

```bash
# typecheck
npx tsc --noEmit -p .
# one fix's tests
npx vitest run tests/lib/<file>.test.ts
# baseline comparison (same file list in both)
npx vitest run $S | grep -E "^ FAIL|Tests " | sort -u > /tmp/w.txt
(cd ../vco-baseline && npx vitest run $S | grep -E "^ FAIL|Tests " | sort -u > /tmp/b.txt)
diff <(grep FAIL /tmp/b.txt) <(grep FAIL /tmp/w.txt) && echo SAME
# MCP tests
cd ../vanna_mcp/vanna-mcp && .venv/Scripts/python.exe -m pytest tests/<file> -q
```

Live debugging: read `.local/copilot-diagnostics/<day>.jsonl` (dev-only, per turn); read the page with DevTools `evaluate_script`; read `diagnostics` from the `/api/copilot/investigate` response; server lines come from Aditya's terminal (ask him to paste).
