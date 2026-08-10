# Copilot — open issues, by owner

Everything known-broken or unfinished as of **2026-08-10**, grouped by who can fix it.
Fixed items are in git history, not here. Anything marked **UNVERIFIED** has passing tests
but has not been exercised against the chain.

---

## A. Contracts team

### A1. `withdraw_collateral_balance` blows the Soroban CPU budget — **the main one**
Simulation returns `HostError(Budget, ExceededLimit)` on accounts holding several collateral
tokens. The withdraw itself is fine: the Margin page submits anyway and it lands.

Cause is that the entrypoint walks **every** collateral token, so cost scales with how many
assets an account holds. It reproduced on a 7-token account and did **not** on a 5-token one
— i.e. it gets worse as accounts grow, and it will hit ordinary users.

Ask: a per-token withdraw path, or reduce the per-token work.

Workaround in place: the copilot falls back to the site's own budget-tolerant executor
(§C1) — **UNVERIFIED live**, because the authorised test wallet does not trip the limit.

### A2. Blend XLM reserve reports 366.53% supply APY
Almost certainly a decimals/scaling error. It is rendered to users as-is.

### A3. Aquarius pools report 0.00% APY, XLM/USDT reports $0.00 liquidity
XLM/USDC and XLM/USDT are the only two farmable pairs (XLM/AQUA does not exist — the copilot
used to claim it did). Both come back with no usable stats. Unclear whether XLM/USDT exists
at all on testnet; worth confirming.

### A4. `deposit_and_borrow` is unreachable as an atomic call
`is_borrow_allowed` runs against collateral *before* the deposit leg of the same combined
call is credited, so a levered deposit+borrow can never pass its own pre-flight. The copilot
splits into two signatures to work around it. Fixing the ordering on chain would remove a
signature from the most common levered flow.

---

## B. MCP team

### B1. `max_borrow` — improved, worth finishing
Was ~22s (48 sequential `is_borrow_allowed` calls). Now ~8–9s via a k-ary search
(8 concurrent probes/round) — deployed as `vanna-mcp-server-00078-4lm`.

Predicted ~10×, got ~2.4×: each round costs the slowest of its 8 probes and something below
(Soroban RPC or the client) is not giving full parallelism. Worth profiling — a 2s
`max_borrow` is achievable and this is the read behind "how much credit do I have".

Answer is unchanged to 4 significant figures (1740.1412 → 1740.1295, ~0.0007% lower). The
epsilon stop understates rather than overstating, which is the safe direction.

### B2. Two pre-existing test failures
`tests/test_mcp_sign_tools.py::test_enable_auto_sign_success_forwards_and_summarizes` and
`..._forwards_optional_caps_and_expiry`. They assert `functionAllowlist == ["borrow","repay"]`
while the code sends the full default list. Red before any change in this session (confirmed
by stashing). 540 other tests pass.

### B3. `ALLOWLIST_FIX_PLAN.md` — DELETED 2026-08-10
Its five contract addresses were all from a previous Registry deployment. Running its
`gcloud` command verbatim would have replaced a working 12-address allowlist with 5 stale
ones and broken auto-sign for margin ops that currently work — while reading authoritative.
Its recommended fix was also already deployed.

Recover with `git checkout d2b988b -- ALLOWLIST_FIX_PLAN.md` if ever needed. The parts that
were still true are preserved where they cannot go stale: the entrypoint names and the
override mechanism are documented in the `default_write_function_allowlist()` docstring in
`mcp_server/tools/sign_tools.py`.

**Rule this leaves behind:** live contract addresses come from
`vanna_list_protocol_addresses`, never from a document. The Registry gets redeployed.

### B4. Simulation is a hard gate on every write path
`_sim_to_unsigned_tx` (`vanna_core/contracts/account_manager.py:45`) raises whenever
simulation fails, so no envelope is ever returned. That is the right default — simulation is
what proves a tx does what it claims — but it means MCP can never express "this failed for a
resource reason, here is the envelope anyway". Only worth revisiting if the §C1 client
fallback proves insufficient.

---

## C. Copilot / this repo

### C1. Withdraw local fallback — **UNVERIFIED live**
On a budget-class failure for an op the browser can run, `runWrite` returns an executable
action with no XDR, which routes to `executeAction` → `MarginAccountService
.withdrawCollateralBalance` (the Margin page's own path). Typechecks, 694 tests pass, never
triggered against the chain because the authorised wallet's withdraw simulation succeeds.
**Test next time a withdraw hits a budget error.**

### C2. Dev server hard-exits under sustained load — diagnosed, not fixed
Every route 500s, then the process disappears. Not reproducible on demand (30 sequential
mixed requests → 0 failures; 10 reads → +12 MB). Turbopack baseline is 3.2 GB RSS, near
Node's default ceiling, so OOM is the leading hypothesis. No unhandled rejection exists in
the copilot path — every MCP/Vertex call is awaited and wrapped. Mitigation:
`NODE_OPTIONS=--max-old-space-size=6144`.

### C3. Answers that dump instead of answering
- "What is the total value locked across all earn pools?" lists the four pools and never
  totals them.
- "Compare the XLM and USDC pools" dumps all four with no comparison.
- "Is Blend yield better than the Vanna USDC earn pool?" claims the earn figure is
  "not available" — it fetched 11.51% one prompt earlier. It has the data; it does not fan
  out to both sides.

### C4. Projections answer with current state
- "Simulate borrowing 10 USDC — what happens to my health factor?" returns **current** HF.
- "What's my liquidation price?" declines, though `collateralLeftBeforeLiquidation` exists.

### C5. Contradictory instructions are executed, not questioned
"whichever earn pool is paying the most, put 15 SOUSDC into it" is impossible as stated —
SOUSDC can only enter the SOUSDC pool, which pays 0.04% against BLUSDC's 11.51%. The false
"highest paying" claim is gone, but it still silently supplies to the worse pool instead of
saying so and offering BLUSDC.

### C6. Vertex prompt caching — my earlier claim was wrong
I reported the routing prompt (3,591–3,604 tokens) was under the 4,096 minimum so "nothing
is cached". Observed since: `route:fc prompt=3604 cached=1461 (41%)`. **Caching is already
partially working**, and `logUsage`'s floor warning is misleading — it says no discount
applies while 41% is demonstrably cached. Fix the warning, not the prompt.

The real remaining lever is **thinking tokens on routing** (400–1,758 per turn, billed at
output rates — comparable to or larger than the entire prompt). Turning them down would cut
cost meaningfully but trades routing accuracy for money, which is a decision, not a patch.
Measure before choosing.

### C5b. Manual margin-account creation with auto-approve OFF — **STILL OPEN**
Owner: opening an account on a new wallet works with auto-approve ON, fails with it OFF —
which is the default for every user.

The confusing message is fixed (`stripAutoSignPlumbing`), but **the functional path was never
verified** and the owner re-raised the bug after that fix. Do not treat the wording fix as the
fix. Verify: auto-approve OFF → `create a margin account for me` → a real Approve & sign
button → Privy signs → a C-address returns. `create_account` is in `EXECUTABLE_OPS`, so the
local executor is available as a fallback if MCP's XDR is unusable.

Test with the owner-supplied fresh wallet
`GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52` (no margin account yet).

### C5c. Session log shows "in progress" after a turn completed — owner-reported
Not investigated. Rows are driven off `strategyStepsRef` / `setStrategySteps` in
`copilot-workspace.tsx`. Suspects: a terminal status no branch maps to done;
`claimFirstAwaitingLeg` stamping a tx hash while deliberately keeping the leg pre-terminal for
the ledger wait and never resolving; or a chain hop finishing without updating the parent row.
Reproduce with a multi-leg approve and diff the row against `execution.status`.

### C7. Percentage-of-balance amounts are not honoured
"deposit XLM 50% of XLM in my wallet into the XLM pool" replies "How much XLM do you want to
supply?" — a question answered with a question. The user gave a size: 50% of a quantity the
copilot can read. `findAmountFraction` already exists and is wired for **repay only**; the
Earn page offers the same 10/25/50/100% rungs. Extend fraction sizing to `lend` /
`deposit_collateral` (needs a wallet-balance read for lend, a collateral read for deposit).

### C8. Dual borrow is only half-represented
"deposit XLM 500 … and borrow BLUSDC **and XLM** at 3X" now yields
`deposit_and_borrow 500 XLM @3x (borrow BLUSDC)` + `borrow ? XLM @3x` — so the second borrow
asset survives but is unsized, and the 3× is applied to a leg that already consumed it.
The Margin page has an explicit **Dual Borrow** toggle, so this is a real product shape, not
a malformed prompt. It needs a first-class two-borrow-asset representation with the leverage
split across both legs rather than duplicated.

### C9. Emoji-only input is refused with the off-domain message
"🚀🚀🚀" hits `block:default`. Harmless, but the message is wrong for it.

---

## D. Product decisions needed — not bugs

These are the two places the copilot currently guesses, or refuses to. Both need a rule from
the product owner; neither should be invented in code.

### D1. Does `deposit_and_borrow` get a default leverage?
Today an unspecified levered deposit+borrow defaults to **2×**. I removed the equivalent
default on plain farms — "farm it on Blend" no longer silently becomes a 2× levered position
— but left this one, because "deposit **and borrow**" does explicitly ask to borrow, so
*some* multiple is implied.

The options:
- **Keep 2×.** One fewer question; the plan card states it, so it is visible before approval.
- **Ask instead.** `planLeverage` already returns a clean "What leverage do you want on 20
  XLM? e.g. 2x or 3x" when leverage is null. Never guesses, costs a round-trip.

My view: ask. A borrow size is the one slot where a wrong default is expensive, and the
prompt is already good.

### D2. Should a stated HF floor size the borrow?
"Deposit my 50 BLUSDC and run a delta-neutral XLM carry, **keep me above 1.4 health**"
decomposes correctly (deposit BLUSDC → borrow XLM → lend XLM) but does **not** size the
borrow to land on 1.4, so the user is asked for the amount mid-plan.

Sizing it is arithmetic — but health factor is **whole-account**, so on the test account the
1.4 floor permits roughly **$878 of XLM borrow** against a 50 BLUSDC deposit:

```
max_debt = (collateral + new_deposit) / floor − existing_debt
         = (1292.78 + 50) / 1.4 − 80.82  ≈  878 USD  ≈  5,300 XLM
```

That satisfies the constraint and is almost certainly not what someone means by "a carry on
my 50 BLUSDC".

**The website already answers the "measured against what" half.** `components/margin/
borrow-box.tsx` (the leverage slider) derives the borrow as
`collateral_in_this_form × (leverage − 1)` — i.e. leverage is relative to **the deposit in
this transaction**, not the whole account. The copilot's own `leverage-plan.ts` agrees:
"3× means total position ≈ 60 BLUSDC on 20 BLUSDC equity (deposit 20 + borrow 40 = 3×)".
So there is no decision to make here — the rule exists, it is just not applied to the
HF-floor case.

**What genuinely remains** is the role of the floor. "Keep me above 1.4" is a *constraint*,
not a *target*: someone saying it wants not to be liquidated, not to be taken to the edge of
their limit. So the floor should stay a blocking guardrail (which `risk.ts` already does) and
must never become a sizing input. Size comes from a stated multiple or amount; if neither is
given, ask.

The remaining genuine gap is only the **adjective mapping** — "conservative" / "safe" /
"aggressive" have no defined multiple, which is what stops the PDF's flagship prompt ("open a
conservative 3x long XLM position") from acting. Note that prompt states 3× explicitly, so it
only needs "conservative" to mean "respect a floor", not to pick a number.

---

## E. Deployed this session

| Service | Revision | Change |
|---|---|---|
| `vanna-mcp-server` | `00077-dkr` | `deposit` + `redeem_vtokens` added to `default_write_function_allowlist()`. Earn lend/redeem now auto-sign. **Verified:** tx `8eb72c92c1…347a9f` |
| `vanna-mcp-server` | `00078-4lm` | k-ary `max_borrow` search. **Verified:** 22s → 8–9s, same figure |

Sign Service was **not** changed — its deployed config (`vanna-sign-service-00044-tlm`) was
already correct. The bug was the MCP overriding it with a narrower explicit list.

**Note on rollback:** if `available credit` ever looks materially wrong, roll MCP back to
`00077-dkr`. That isolates the search change from the allowlist change.
