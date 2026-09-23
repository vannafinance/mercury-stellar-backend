# Catalogue — live UI run, 23 Sep, `try/investigate-first`, wallet GDW3B2…VJ52, auto-approve ON

Aditya drives the browser; results read from the rendered page, the network panel and the
local audit trail. "Approve" = Aditya clicked it; otherwise the plan card was only inspected.

| Row | Prompt | Understood as | Outcome | Notes |
|---|---|---|---|---|
| E1 | lend 50 XLM | (run collided — I and Aditya typed at once) | — | re-run |
| E2 | supply 25 AQUSDC to earn | Supply 25 AQUSDC into Vanna Earn pool → Lend 25 AQUSDC | cancelled by user | UI: EXECUTION PROGRESS "Queued" card sits above "Not executed" — a cancelled plan still writes a receipt |
| — | lend 20 xlm | Lend 20 XLM into Vanna Earn | **executed, settled** tx 5af8de69…, ledger 4824185 | first full propose→approve→advance on investigate-first |
| — | lend me 20xlm | Borrow 20 XLM from Vanna Margin | plan offered with Approve | debt guard runs on fresh code and still passes it — OPEN |
| E3 | lend 10 SOUSDC | Lend 10 SOUSDC to Vanna Earn | proposed (b1d41470), not approved | once the next turn starts, the plan card vanishes and the headline "Approve to run this step" stays with nothing to approve; | after moving on, E2's "Not executed" card disappears but its stale "Queued" execution card stays in history |
| E4 | redeem 10 XLM from earn | Redeem 10 XLM from Vanna Earn → "Redeem 9.9451295 XLM vTokens (≈ 10 XLM)" | proposed (450df780) | PASS: pro-rata vToken sizing as catalogue expects. UI: pocket says "Earn · XLM 44.8665031 available / Plan spends 9.9451295" — 9.945 is vTokens, labelled XLM; units ambiguous |
| E5 | redeem all my AQUSDC from earn | Redeem all AQUSDC from Vanna Earn → whole vToken balance 14.8783043 (≈ 15.1755174 AQUSDC) | proposed (89781434) | PASS: redeems the full vToken count, so no dust. UI: step reads "(≈ 15.1755174 AQUSDC) (14.8783043 AQUSDC)" — two numbers both labelled AQUSDC, the second is vTokens |
| E6 | what is my earn position? | Check current Vanna Earn positions across all assets | answered | PASS: vTokens + underlying per pool. Read path labels vTokens CORRECTLY (VXLM, VAQUSDC) — so item 9 is the plan card not reusing it. Leak: BLUSDC's vToken shown as "VUSDC" (wire name) not vBLUSDC |
|  | (history) | — | — | E3/E4/E5 each collapse to "…Approve to run this step" after moving on: no card, no outcome (UI item 10) |
| E7 | what is the XLM supply APY | current XLM supply APY across Earn and Blend | answered | PASS after f3a73e4: "XLM Earn 2.76% APY; XLM Blend 450.46% APY" — matches /earn 2.76% and /farm ~450.29% |
| M1 | deposit 100 XLM as collateral | Deposit 100 XLM as margin collateral, no new borrowing | proposed (07ca2e11) | PASS: funded from wallet (2,561.41 XLM available). Plain action still gets an Approve card (UI item 8) |
| X1 | deposit 100 XLM as collateral and borrow 20 BLUSDC | both legs, deposit → borrow, borrowing required | **EXECUTED both legs** (70c4e578): deposit tx a6f00f32 ledger 4824456, XLM collateral +100, BLUSDC debt 299.64→319.64 | PASS on legs/order. Gap: card shows only CURRENT HF 2.31, never the projected HF after the borrow — the figure a user decides on |
| X2 | deposit 100 XLM, borrow 20 BLUSDC and supply it to blend | understood perfectly (3 legs, "supply the borrowed BLUSDC") | REFUSED wrongly — "the amount 20 does not appear in your request" | FIXED 912afc6, VERIFIED LIVE: 3 legs deposit→borrow→supply 20 BLUSDC; supply funded from the margin account "available after earlier plan steps" (8ee55cc2). **EXECUTED all 3 legs** 06:55:17 / :27 / :37 (deposit ledger 4824586, borrow 4824588). "Done" shown while leg 3 Queued again (item 14/15) |
| X3 | redeem 20 AQUSDC from earn and deposit it as collateral | Redeem 20 AQUSDC then Deposit 20 AQUSDC ("it" = AQUSDC ✓) | correctly refused: only ~15.18 redeemable | UI: "only 15.175689561344202486 AQUSDC" — 18 decimals, raw WAD precision leaking (AQUSDC has 7) |
| X4 | borrow 20 SOUSDC and provide it with XLM as liquidity on soroswap | Borrow 20 SOUSDC → Add 20 SOUSDC + 109.9772472 XLM to Soroswap | proposed (c8474afe) | PASS: paired side quoted from live reserves; SOUSDC funded "after earlier plan steps". Note: pool ratio implies XLM ≈ 0.182 SOUSDC vs oracle ≈ $0.22 — ~17% skew; worth surfacing in the plan, not a sizing bug |
| X5 | swap 50 XLM to AQUSDC and add it as liquidity with XLM on aquarius | Swap 50 XLM → AQUSDC, add the resulting AQUSDC with XLM on Aquarius ✓ | REFUSED | (1) quote 50 XLM → 0.5728 AQUSDC ≈ 95% loss at oracle ~$0.22/XLM (Aquarius testnet pool badly skewed). (2) message blames the SWAP refusal on the add-liquidity reason. (3) it offers "state that you accept the quoted loss" at a ~95% loss. (4) refuses to chain "previous leg" after a swap although the swap's enforced minimum output is a known bound; catalogue expects the chain to work |
| X5b | i accept the loss | re-planned correctly, "accepting any potential loss" | REFUSED: "the amount 50 does not appear in your request" | anchor reads only the latest turn. Dead end after copilot asked for exactly this. Failing was lucky — success would have executed a ~95% loss swap |
| X7 | remove my XLM/SOUSDC liquidity and repay my BLUSDC debt | Remove 11.0639364 XLM/SOUSDC LP shares → Repay 339.6414649 BLUSDC | option shown; PREPARE FAILED | (1) "Using SOUSDC — you hold 340 of it, so no swap is needed" on a BLUSDC repay — wrong token, or a swap wrongly declared unnecessary. (2) "Health factor after 1.95" from 2.30 while repaying debt — unexplained drop. (3) Prepare → "no SOUSDC LP position was read this investigation" though the option was sized from that LP read (11.06 shares). (4) Options card on a plain multi-action (UI 12) |
| X11 | deposit 100 XLM then borrow to the floor | run 1 asked asset + floor; run 2 ASSUMED XLM and asked floor | needs_input / refused | Asset question is fair (none named). Floor question is not: the user's configured floor is shown as "1.40 your floor" on the health bar — "the floor" should resolve to it. Question also printed twice (reply + "Needs your answer" box) |
| X11b | 1.5 (reply) | Deposit 100 XLM and borrow XLM to HF 1.5 | proposed (22d331f2) | PASS on shape: ONE plan, 100 XLM kept across turns, HF after 1.50. BUT: (1) borrow asset XLM was never chosen by the user. (2) only the deposit was simulated — "the other step follows from it and stand on the projection"; the 5,563 XLM borrow is unsimulated. (3) copy "$1,226.00 using idle funds only; the supply rate could not be read" on a BORROW plan. UI: Options card AND plan card both render the same plan |
| — | (owner) | — | — | X7 shape confirmed correct by owner; X11 floor question and XLM inference confirmed intended |
| X10 | deposit 100 XLM … borrow 2x BLUSDC and SOUSDC … BLUSDC in blend and SOUSDC and XLM in soroswap | 5 legs: deposit 100 XLM → borrow 11.0374971 BLUSDC → borrow 11.0374971 SOUSDC → supply 11.04 BLUSDC Blend → add 11.04 SOUSDC + 60.69 XLM Soroswap | proposed (83caba6f) | PASS: 2x = ~$22 borrowed, SPLIT evenly across the two borrow assets (dual-borrow split, no doubled leverage); correct order and pockets; one plan card with Approve per the multi-leg rule. UI: status line pinned to the bubble (item 19) |
| X13 | remove XLM position or USDC position from blend farm | Withdraw the active BLUSDC position (XLM Blend position is zero) | proposed | PASS on logic — resolved by fact, not a guess (only one of the two positions exists). Untested: the case where BOTH exist, where it must ask. UI: reason buried in a chip, not in the reply (item 20); wrong "using idle funds only" copy on a withdrawal |
| X10 | (execution) | legs 1–4 executed (BLUSDC debt +11.04), leg 5 add-liquidity stopped: "pool's live reserves could not be refreshed" | STOPPED at leg 5 | Root cause in vanna_mcp: soroswap pool-stats compares str(Address) to a strkey, so token0 never matches → reserves swapped and fee "" whenever SOUSDC is asked first. Card said "Not executed" though 4 of 5 legs settled |

## X10 retest after MCP 2a7503e (vanna-mcp-server-00105-4f8), 23 Sep

**PASS, 5/5 executed.** Workflow `119f85e1`. Step 5 (Soroswap add-liquidity) was now priced at 10.939476 SOUSDC + 60.1546728 XLM and settled, tx `0e238f5b…29159`, ledger 4825618, `successful: true`. The pre-execution ratio refresh used 10.9394759 SOUSDC + 60.1546728 XLM, within the approved amounts. This confirms the token0 fix live.

Still seen:
- The advisory note "did not quote a borrow size" sits under a plan that did size both borrows (10.939476 each). The note contradicts the card (UI-FIX-LIST "advisory notes").
- On the plan card, the margin account · BLUSDC row stayed at "Checking… available" and never resolved.

## X12 "withdraw all funds", 23 Sep

**FAIL on shape.** "Understood as" was right ("across Earn, Farm, and Margin"), but the reply offered per-venue OPTIONS instead of one plan covering every venue named. Options are for alternatives, not for parts of one request.
- **Earn option "Amount $52.07":** only the last of 4 independent redeems (≈ $45 + $102 + $15 + $52). FIXED locally: `valueMovedWad` in plan.ts counts each leg once through `feeds` + `producedAsset`, so a redeem feeding a deposit is still one sum. Test `tests/lib/plan-value-moved.test.ts` (4). The 4 failures in plan-shape-matrix / investigation-plans-e2e fail identically without the change.
- **Farm option "Amount $0.00":** Blend + LP legs carry no USD value. Not fixed.
- **Farm step label "Blend 181.9036899 BLUSDC":** the verb is missing. The option also exits to the margin account, which is not a withdraw to the wallet.
- **Margin ruled out: "repay SOUSDC: the repay is larger than the outstanding debt".** SOUSDC debt is 21.98 (XS5 debt read), so this is a repay sized above the real debt. See FIX-LIST item 11.
- **Wrong copy:** "using idle funds only; the supply rate could not be read" on a withdrawal (known template misuse).
- **Stale note:** "earn position: data was unavailable" appears while the Earn option lists 4 read positions.

## X14 "rebalance out of LP into whichever venue pays more", 23 Sep

**FAIL.** Both shapes (exit Soroswap LP → supply XLM to Blend, exit Aquarius LP → same) were refused with "previous_leg needs a preceding leg in the same asset".
- The message is misleading. `producedAsset` returns ONE asset per leg, and a remove_liquidity leg produces two (the pool's pair), so the producer lookup never finds it.
- Even if it matched, plan.ts deliberately refuses previous_leg after remove_liquidity ("pays back two tokens, how much is not known in advance").
- Real fix candidate: size the exit's payout from the LP position read (share × reserves, with a min-out tolerance) so the next leg has a figure. `producedAsset` is shared by every handoff, so the change needs the full plan suites. Not changed yet.

## XS5 "unwind my positions safely and leave me with the least risk", 23 Sep

**FAIL, no plan.** One Earn read and one LP read errored; both model plans were dropped by the decision parser with no recorded reason; the reply is a balance dump. See FIX-LIST items 10–11.

## XS6 "use my whole wallet to earn the most without taking new debt", 23 Sep

**FAIL, asked instead of planning.** It returned "Which venue would you like to use…" with the rates it had already read. "Earn the most" is the selection rule: per asset, the highest readable rate (XLM → Blend 173.43% APR; BLUSDC/AQUSDC/SOUSDC → Earn, each above its Blend rate). It should plan that, one plan, no debt. A wallet → Blend leg must go deposit_collateral → supply_blend.
- Earn rates are labelled "APR" in this question, but E7's fix shows the same numbers as APY. Label inconsistency.
- "earn market: data was unavailable": another failed read (see FIX-LIST 8/10).
- Aquarius LP was offered as a choice with no evaluated return.
- The first attempt shows "Cancelled"; per the owner that was a user cancel.

**XS6 follow-up, reply "farm":** Options were (a) deposit 2152.2879106 XLM → supply to Blend, 173.44% APR, $464.13, HF 2.30 → 2.02; (b) deposit 680 BLUSDC → supply to Blend, 1.54% APR, $679.98, HF 2.13. Aquarius XLM/AQUSDC was ruled out: "Add spends the margin account — deposit the idle tokens as collateral first."
- "Whole wallet" was split into per-asset OPTIONS, not one plan (FIX-LIST 1).
- Aquarius was refused for a deposit step the planner itself composes for Blend. The prerequisite deposit should be composed for add_liquidity the same way, or the refusal is inconsistent.
- HF falls (2.30 → 2.02) on a no-debt deposit+supply. Unverified whether the RiskEngine weights Blend-supplied collateral lower. Check against the contract before calling it a bug.
- The supply leg is unsimulated ("the other step follows from it and stand on the projection"), with garbled copy (same as X11).
- Each turn shows "Cancelled. Nothing was submitted" before a repeat of the prompt. Confirm with the owner whether those were manual cancels.

## XS7 "optimize my portfolio for yield but keep 100 XLM liquid", 23 Sep

**FAIL, same as XS6.** It asked "Which yield venue would you prefer…" instead of applying the objective (best readable rate per asset). The "keep 100 XLM liquid" reserve was never shown, so it is untestable until a plan is built. Failed reads: earn position, blend position (FIX-LIST 12, 14).

**XS7 follow-up, reply "blend": 3 bugs.**
1. **Reserve ignored (correctness).** The plan deposits 2152.2879106 XLM, the whole spendable balance, despite "keep 100 XLM liquid". The constraint WAS sent: request history carries the first turn verbatim. The model sized XLM as all_idle; nothing in the sizer or verifier enforces a user-stated reserve.
2. **Reply cut off.** The investigate request for "blend" ended `net::ERR_ABORTED` (09:02:24 UTC). The page shows only the summary ("2 other options below. Approve to run those steps.") with no option cards and no Approve button. Possibly the same cause as the unexplained "Cancelled. Nothing was submitted" lines on XS6.
3. **HF inconsistent.** XLM alone → 2.02 and BLUSDC alone → 2.13 (XS6), but both together → 2.35 from a 2.30 start.
