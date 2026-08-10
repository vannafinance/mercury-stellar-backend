# Copilot — next session brief

Self-contained. Start here, in this order. Written 2026-08-10 at the end of a long session;
everything below is either verified live or explicitly marked unverified.

Read alongside: [README.md](./README.md) (how it works), [ONBOARDING.md](./ONBOARDING.md)
(run it + safety), [OPEN-ISSUES.md](./OPEN-ISSUES.md) (full issue list by owner).

---

## 0. Setup (5 min)

```bash
NODE_OPTIONS=--max-old-space-size=6144 npm run dev     # never a second `next dev`
curl -s http://localhost:3000/api/copilot              # expect mcp_mode live, templates 14
```

Test wallet (owner-authorised, **this one only**):
- G-wallet `GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5`
- Smart account `CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C`
- Wallet holds ~9.8k XLM, ~900 BLUSDC, ~900 AQUSDC, ~49k SOUSDC. Plenty for testing.
- **Fresh wallet, owner-supplied 2026-08-10 for new-account testing (Task 1):**
  `GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52` — has no margin account yet,
  which is exactly what Task 1 needs. Authorised.
- A third wallet appears in owner screenshots (`GAXJMQ…44WV` / `CBARZ7…VGGK`) — **not
  authorised**, do not write to it.

**Auto-sign executes single-leg writes immediately — no preview, no approval click.** Cycle it
with "disable auto-sign" then "enable auto-sign with default caps" (must be done in the
BROWSER; the assertion is not on plain curl calls). The owner wants **both states tested**.

Baseline to preserve: `npx tsc --noEmit` clean, `npx vitest run` = **694 passing**.

## 1. Test through the browser, not curl — the owner wants to watch

Coordinate clicking does **not** work in a non-compositing browser pane, and `form_input`
alone does not update React state. Drive the DOM. Paste this once per page load:

```js
const setVal = (el, v) => {
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
};
window.__ask = (t) => {
  const el = document.querySelector('input[placeholder*="Ask, or state"]');
  const f = el.closest('form'); setVal(el, t);
  const b = [...f.querySelectorAll('button')].find(x => x.type === 'submit');
  if (!b) return 'busy'; b.click(); return 'submitted';
};
window.__state = () => {
  const s = document.body.innerText;
  const i = s.indexOf('YOUR INTENT'), j = s.indexOf('SESSION LOG');
  const r = (i >= 0 && j > i) ? s.slice(i, j).trim() : '';
  return { busy: /working…/.test(r), text: r };
};
window.__approve = () => {
  const b = [...document.querySelectorAll('button')].find(x => /Approve & run/i.test((x.textContent||'').trim()));
  if (!b) return 'no approve'; b.click(); return 'approved';
};
```

**After any server-side edit, hard-reload.** A dead HMR socket leaves a stale bundle that
silently posts nothing — this wasted 20 minutes last session looking like a submit bug.

**The first request after an edit is 9–11s (Turbopack recompiling).** Never measure latency
on it; take medians over 4+ samples.

---

## 2. Work queue, highest value first

### Task 1 — Manual margin-account creation (owner's top complaint, PARTIALLY DONE)

Owner: *"when I try to open a margin account through a new wallet it works if auto-approve is
ON but doesn't work if it's OFF, which is the default for every user."*

What was done: MCP returns an auto-sign diagnostic and the copilot was pasting it raw into the
card — internal endpoint path, credential model, doubled full stop, ending "You can still sign
the unsigned_xdr with your own wallet". `stripAutoSignPlumbing()` in `execution-copy.ts` now
removes that class of text on the wallet-sign path.

**What was NOT verified, and is the actual task:** that with auto-approve **off**, a new wallet
can *complete* account creation end to end — Approve & sign → signed → C-address returned. I
only fixed the wording. The owner re-raised it after that fix, so assume the functional path is
still broken and prove it either way.

How to test properly: turn auto-approve OFF, run `create a margin account for me`, and check
(a) a real Approve & sign button appears, (b) clicking it signs via Privy, (c) a C-address
comes back. `create_account` is in `EXECUTABLE_OPS`, so if MCP's XDR is unusable the local
executor (`components/copilot/execute.ts` → `MarginAccountService`) is the fallback, same
pattern as the withdraw fallback in `runWrite`.

Note the existing account already exists for the authorised wallet, so it answers "You already
have a margin account". Use the owner-supplied fresh wallet
`GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52` — it has no account yet.

### Task 2 — Session log shows "in progress" after completion (owner-reported)

Owner: *"sometimes in session log it still showed in progress when completed."*

Not yet investigated. Start in `components/copilot/copilot-workspace.tsx` — the session-log
rows are driven off `strategyStepsRef` / `setStrategySteps` and a per-turn status. Suspects:
- A terminal status that no branch maps to done, so the row keeps its running style.
- `claimFirstAwaitingLeg` stamping a hash without moving the row out of pre-terminal state
  (this is deliberate for the 30–60s ledger wait — check it resolves afterwards).
- A resume/chain hop finishing while the parent row is never updated.
Reproduce with a multi-leg approve, then compare the row against `execution.status`.

### Task 3 — C7: percentage-of-balance amounts

`deposit XLM 50% of XLM in my wallet into the XLM pool` → *"How much XLM do you want to
supply?"* A question answered with a question: the user gave a size.

`findAmountFraction` (`lib/copilot/amount-intent.ts`) already parses these and is wired for
**repay only** (`resolveRepayAmount` in `handle.ts` sizes off live debt and caps to spendable —
copy that shape). The Earn page offers the same 10/25/50/100% rungs, so this matches the site.

Needs: a wallet-balance read for `lend`, a collateral read for `deposit_collateral`. Reuse
`walletBalanceForEarn` (`mcp-write.ts`) and `readMarginPositions` (`handle.ts`). Leave the
~0.5 XLM fee reserve alone — `preflightLend` already knows about it.

### Task 4 — C8: dual borrow (spec confirmed from the owner's screenshot)

The Margin page has a **Single Borrow / Dual Borrow** toggle. Screenshot values:

```
Deposit  100 XLM              ($16.38)
Borrow   16.3735 BLUSDC       ($16.38)
Borrow   100 XLM              ($16.38)
Total    $32.77       Max     $32.77
```

So: **leverage counts the TOTAL borrow across both legs**, split evenly by USD value.
Deposit $16.38 + borrow $32.77 = $49.15 total position = **3× equity**. Each borrow leg is
`deposit_value × (L − 1) / 2`.

Current behaviour after last session's fix: `deposit XLM 500 … borrow BLUSDC and XLM at 3X`
yields `deposit_and_borrow 500 XLM @3x (borrow BLUSDC)` + `borrow ? XLM @3x` — the second
asset survives but is unsized, and 3× is duplicated onto a leg that already consumed it.

Needs a first-class two-borrow-asset shape. `deposit_and_borrow_cross` already exists in the
Sign Service function allowlist, so check whether MCP supports a cross/dual borrow directly
before building it as two legs. `leverage-plan.ts` owns the sizing maths — extend it there,
not in the router.

**How the owner wants this approached (their framing, 2026-08-10).** Treat a multi-layered
prompt as separable layers and resolve each one, rather than pattern-matching the sentence as
a whole. For *"deposit 500 XLM into margin account and borrow BLUSDC and XLM at 3X leverage"*:

| Layer | Value | Handling |
|---|---|---|
| Action 1 | deposit 500 XLM | collateral leg, sized |
| Action 2 | borrow **BLUSDC and XLM** | **two** assets → two borrow legs |
| Modifier | at 3× leverage | sizes the borrow **total**, split across both legs |

Each layer is individually simple; the difficulty is only that they arrive in one sentence.
Their point is that Gemini's job is the **split** — decompose into ordered actions plus
modifiers — and the deterministic code then sizes each resulting leg. So the fix belongs in
decomposition (`step-extractor.ts` producing two borrow legs) plus sizing
(`leverage-plan.ts` dividing `deposit_value × (L−1)` across them), NOT in a wider regex.

Note the modifier currently gets duplicated onto every leg it touches, which is the visible
symptom: `@3x` appears on both the `deposit_and_borrow` and the trailing `borrow`. A modifier
should be applied **once, to the group**.

### Task 5 — Adopt the floor rule (small, prevents a class of bug)

**A health-factor floor is a constraint, never a sizing input.** "Keep me above 1.4" asks not
to be liquidated, not to be taken to the edge of the limit. Floor sets `min_hf` only (blocking,
already works via `risk.ts`); size comes from a stated multiple or amount; if neither is given,
ask — offering the site's own **1× / 3× / 5× / 7× / 10×** rungs as chips (wire like the
USDC-variant chips: `clarify_options` + `pending_write`).

Settled last session, no decision needed: `components/margin/borrow-box.tsx` derives borrow as
`collateral_in_this_form × (leverage − 1)`, so **leverage is measured against the deposit in
the transaction, not the whole account**, and `leverage-plan.ts` already agrees.

Related: drop the `deposit_and_borrow` default of **2×** and ask instead. A wrong default is
wrong silently and gets approved by someone skimming; a wrong answer to a question has to be
actively chosen. Expect `tests/lib/leveraged-margin.test.ts` and `leveraged-plan-path.test.ts`
to need updating — and check whether each assertion encodes the old default as *behaviour* or
as a *rule* before changing it (an `extractOrderedPlan` test last session turned out to encode
a limitation, not a requirement).

### Task 6 — C3/C4: reads that dump instead of answering

- "total value locked across all earn pools" — lists four pools, never totals them.
- "compare the XLM and USDC pools" — dumps all four, no comparison.
- "is Blend yield better than the Vanna USDC earn pool?" — claims the earn figure is "not
  available"; it fetched 11.51% one prompt earlier. Needs a fan-out to both venues.
- "simulate borrowing 10 USDC — what happens to my health factor?" — returns **current** HF.
- "what's my liquidation price?" — declines, though `collateralLeftBeforeLiquidation` exists.

### Task 7 — Full-website sweep (owner asked for this explicitly)

Walk every surface and compare what the copilot can do against what the page can:
Portfolio, Earn, Margin, Trade (swap), Farm (Blend + Aquarius LP), Analytics.
For each: does the copilot support every action the page offers, with the same maths and the
same limits? Known gaps already: Aquarius add/remove liquidity, dual borrow, percentage rungs
on Earn/Margin. Record findings in OPEN-ISSUES.md.

---

## 3. Regression set — run in the browser, both auto-sign states

| Prompt | Expected |
|---|---|
| `what are my positions` | Live read. Never "I don't have access" |
| `What is my available credit right now?` | `query_available_credit`, ~$1,740, ~8s |
| `how much XLM collateral do I have` | XLM figure; venue positions listed separately |
| `Park 20 XLM then farm 10 BLUSDC at 2x` | 2 steps, **4 signatures**, earn → farm |
| `Deposit 10 BLUSDC, borrow 5 BLUSDC, then supply that to Blend` | 3 legs, last ≈ **4.9825** (net of fee) |
| `swap 10 XLM to BLUSDC then farm it on Blend` | Farm leg has **no** leverage |
| `lend 15 SOUSDC, then tell me my health factor` | 2 steps, **1 signature**, report runs **after** |
| `deposit XLM 500 into marign account and borrow BLUSDC and XLM at 3X leverage` | 500 and 3× both parsed (typo is intentional) |
| `deposit XLM 50% of XLM in my wallet into the XLM pool` | **Task 3** — must not ask "how much?" |
| `create a margin account for me` | **Task 1** — must work with auto-approve OFF |
| `if my HF is above 2, borrow 5 BLUSDC, otherwise leave it` | `unsupported_conditional` |
| `keep an eye on my position and pull collateral out if it gets risky` | `unsupported_standing_order` |
| `Supply 20 DOGE to earn` / `add liquidity to the XLM/BTC pool` | `unsupported_asset` |
| `Farm Blend at 20x leverage` | Refused, names the 10× cap |
| `Supply -5 USDC` | Refused **before** asking for a wallet |
| `what is Blend?` | Page assistant, not a tool call |

---

## 4. Traps that cost real time last session

- **A swallowed exception in a retry loop looks like a slow network.**
  `BigInt(acc.sequenceNumber)` — a method, not a property — threw every iteration inside a
  `catch` marked "transient", so every multi-leg hop stalled 16s then reported the sequence
  had never applied. Fixed; the pattern will recur.
- **`git checkout <file>` reverts the whole file.** I wiped a verified latency fix that way
  and had to rebuild it. Use targeted edits.
- **Two definitions of one type.** `execute.ts` used to declare its own `CopilotAction` with
  8 of 22 fields and the workspace imported *that*. Now re-exported from `types.ts` — do not
  re-fork it.
- **`_human` vs raw fields.** MCP returns both; only ever show the human one. `factsForUi`
  drops a raw field when a `_human` twin exists.
- **Earn positions live on the G-wallet, not the C-account.** A vToken read scoped to the
  smart account returns 0 for an account that holds a position.
- **Live addresses come from `vanna_list_protocol_addresses`, never a doc.** The Registry gets
  redeployed; `ALLOWLIST_FIX_PLAN.md` was deleted for being confidently stale
  (`git checkout d2b988b -- ALLOWLIST_FIX_PLAN.md` to read it).
- **The floor warning in `logUsage` is wrong.** It says caching cannot apply while
  `cached=1461 (41%)` is observed. Fix the warning, not the prompt.

## 5. Deployed state

| Service | Revision | What |
|---|---|---|
| `vanna-mcp-server` | `00078-4lm` | k-ary `max_borrow` (22s → 8–9s, same figure) |
| `vanna-mcp-server` | `00077-dkr` | `deposit`+`redeem_vtokens` in `default_write_function_allowlist()` — earn auto-sign |
| `vanna-sign-service` | `00044-tlm` | **unchanged** — its config was already correct |

Rollback for `max_borrow` only:
```bash
gcloud run services update-traffic vanna-mcp-server --region=us-central1 \
  --project=vanna-mcp --to-revisions=vanna-mcp-server-00077-dkr=100
```

`gcloud` is authenticated as `aditya@vanna.finance`, project `vanna-mcp`. **Never ask the
owner for credentials.** The MCP repo has deliberate unstaged deletions — do not commit there
without asking.
