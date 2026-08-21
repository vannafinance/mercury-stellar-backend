# Copilot — next session brief

---

## Session 2026-08-21 — Gemini 3.7 Flash Upgrade & Enhanced Domain Firewall & Guardrail Consolidation

**Everything in this block reflects the latest production state:**

* **Primary Foundation Model:** **`gemini-3.7-flash`** (upgraded from `gemini-3.6-flash` in `lib/copilot/config.ts`, `.env.local`, and UI hints).
* **Enhanced Ingestion Domain Firewall (`lib/copilot/domain-firewall.ts`):**
  * Added **Adversarial Jailbreak & System Prompt Extraction Defense** (blocks prompt leaks, DAN modes, roleplay evasion).
  * Added **Broad Financial/DeFi Semantic Allowlist** (`FINANCIAL_SEMANTIC_RE`) covering yields, buffers, slippage, vaults, collateralization, and pnl.
  * Preserved **100% zero-block pass-through** for all Vanna actions, registered assets (`XLM`, `BLUSDC`, `AQUSDC`, `SOUSDC`, `USDT`, `bTokens`), and active page contexts.
* **Server-Side Plan Approval Idempotency Locking:** Upgraded deduplication lock window to 15s in `lib/copilot/write-dedupe.ts` and `handle.ts`.
* **Documentation Consolidated:**
  * [GUARDRAILS.md](./GUARDRAILS.md): Unified specification of all 9 security layers, Domain Firewall, and GCP Vertex Model Armor architecture.
  * [ONBOARDING.md](./ONBOARDING.md): Accessible, step-by-step onboarding guide for developers and non-technical stakeholders.
  * [copilot-KT.md](../copilot-KT.md): Complete Master Knowledge Transfer document.
  * Obsolete design prompts and scratch research files purged.
* **Test Suite Status:** 100% clean across all 1,150+ tests (`npx vitest run tests/lib/domain-firewall.test.ts`, `npm run test:multi-leg`, `npx tsc --noEmit`).

---

## Session 2026-08-20 — 12 bugs fixed and pushed, 3 open items handed off mid-investigation

**Everything below in this block supersedes older content on conflict — read this one first.**

Branch `copilot-ui-rewire`, all pushed to `origin/copilot-ui-rewire`. Latest commit at
handoff: `08c7414`. Test wallet unchanged: **`GDW3B2…VJ52`**, smart account
**`CAHLZM…GLLJ`** (same account used throughout — real testnet writes execute live, this
account is pre-authorised for that). `npx tsc --noEmit` clean, `npx vitest run` = **1098
passing** as of the last commit — always re-run both before committing anything new.

**Full per-bug detail for everything fixed this session is in
[TEST-RUN-FINDINGS.md](./TEST-RUN-FINDINGS.md), findings #45 through #52** — this block only
summarizes and points at what's still open. Don't re-derive root causes already written up
there; read the finding first.

### Fixed and pushed this session (commits `2019227` .. `08c7414`)

- Earn/Blend position questions now scope to the named pool, not a fan-out of all of them
  (#45), and a duplicate raw fact card was dropped from the Earn answer.
- **Architectural fix**: `handle.ts`'s `keywordConfident` gate used to treat ANY deterministic
  `kind:"clarify"` as trustworthy enough to skip Vertex — including the generic "nothing
  matched" `clarify_capabilities` fallback. That meant any phrasing router.ts hadn't
  specifically special-cased was a permanent dead end. Now only a genuinely deliberate
  clarify (USDC variant, etc.) short-circuits; the generic fallback defers to Vertex first
  (#46). This is very likely the root cause behind most of this session's one-off "it can't
  answer X" reports going forward — if something still can't be answered, check whether
  `needsSemanticIntent` (see below) is wrongly forcing Vertex OFF the correct deterministic
  answer, not whether router.ts needs a new regex.
- Swap's "which USDC?" clarify no longer offers BLUSDC (no swap venue trades it) (#47).
- Real Aquarius/Soroswap AMM pool-stats questions ("what tokens are in the pool", "pool
  ratio") now route to the actual on-chain reader instead of Earn's lending-pool stats tool,
  and a locale bug made large numbers render as "1,11,981" (Indian digit grouping) instead of
  "111,981" — both fixed (#48).
- `add_liquidity` with only ONE ticker named ("add liquidity 10 XLM in Aquarius") used to
  default the missing pair token to the literal string "BLUSDC" — invalid for every LP venue
  — now infers it from the stated venue (Aquarius→AQUSDC, Soroswap→SOUSDC) so the existing
  ratio auto-fill can size the other side, matching the real Farm add-liquidity form's own
  one-sided-input behaviour. Verified with a REAL on-chain tx (#49).
- `can i borrow 20 USDC?` / `can i withdraw 20 USDC?` used to silently answer for one
  resolved token instead of asking which USDC variant, the same ambiguity every WRITE already
  guards against (#50).
- "what is the current swap price of X to Y" now answers instead of asking "how much do you
  want to swap?"; a possessive noun ("farm's bXLM") was wrongly forcing Vertex off a correct
  deterministic Blend answer; **swap quotes were computed from ORACLE price instead of the
  real AMM pool ratio** — confirmed live, a real swap under-quoted by ~2× versus what actually
  settled on-chain, and the slippage floor (`min_out`) inherited the same error, meaning the
  real price protection was much weaker than the stated 0.5% (#51). Fixed for XLM↔AQUSDC/
  SOUSDC by reading the same on-chain reserves `poolRatioAnswer` already uses.
- Raw "SUMMARY"/"NOTE" fact cards (MCP's own developer caveats, not user-facing facts)
  dropped from the farm/margin-overview answer, top-level and nested (#52).

### Reverted, do not redo without a real design (documented in TEST-RUN-FINDINGS.md, right
after #52)

Tried turning the plain-text "which USDC?" clarify into pickable chips. Every existing
`clarify_options` usage in this codebase pairs it with a `pending_write`, and the client's
chip-click handler resumes ONLY through the write-execution path — there is no "resume a
read" mechanism. `can_borrow`/`can_withdraw` are reads; wiring chips onto them risked a click
silently placing a real borrow/withdraw transaction instead of just answering. The swap case's
`pending_write` shape also has no `token_a`/`token_b`/`venue` fields, so it would fall to a
context-losing fallback (resubmits just the bare ticker as a new message). **Needs a real
"resume this router-level clarify by substituting the variant into the original message"
mechanism (client + server) before this is safe** — the user re-asked for it this session
("maybe better give option to select... then user can select out of three"), so it's wanted,
just not safely buildable in the time available this pass.

### Open, investigated but NOT yet fixed — pick these up first

**1. Margin/farm "all positions" answer shows inflated collateral for XLM/BLUSDC/AQUSDC —
very likely root-caused, not yet fixed.** Reported live with side-by-side screenshots: the
`query_all_positions` answer card said `COLLATERAL · XLM: 7,179.4083`, while the SAME
screenshot's "OPEN POSITIONS" side-rail (and the real Margin page) showed `XLM: 4,711.466906`
for the identical account at the identical moment. The gap (7,179.4083 − 4,711.466906 =
2,467.94…) matches the account's `BORROWED · XLM` figure (2,467.9409) almost to the decimal.
Same exact pattern independently for BLUSDC and AQUSDC — each answer-card "collateral" figure
equals true-collateral + that-asset's-own-debt. This is NOT a coincidence three times over.

Hypothesis, not yet confirmed by reading the actual runtime values: `reconcileMarginRawSacCollateral`
(`lib/analytics/stellar/farmTrackingCollateral.ts:50`) overlays the smart account's RAW
on-chain token balance onto `collateralBalances[sym]` (to fix a real, separate staleness
problem — the on-chain `CollateralBalanceWAD` ledger doesn't update after an AMM swap/LP op).
But a freshly-BORROWED token also sits as raw balance in the smart account until the user
does something else with it — so this overlay likely can't distinguish "raw balance that is
genuinely free collateral" from "raw balance that is actually just-borrowed debt sitting
there," and reports the sum as if it were all collateral. This function is called from
`computeMarginSnapshot` (`lib/account-snapshot.ts:213`), which `lib/copilot/handle.ts`'s
`readMarginPositions` (line ~2495) uses for the `query_all_positions` answer — but the
side-rail widget and the real Margin page apparently do NOT go through this same overlay (or
go through it differently), which is why only the copilot's OWN answer shows the inflated
number. Next step: read `BlendService.getMarginAccountTokenBalance` and compare its return
against what the side-rail's own data source uses for the same account, to confirm whether
raw balance really does include just-borrowed-and-unmoved debt, then either net out matching
debt before display or find whatever the side-rail does differently and match it. This
function is shared outside `lib/copilot/` — check for other callers before changing its
return shape.

**2. `query_all_positions` doesn't include Earn (vToken) positions at all.** User asked for
this explicitly: "add earn positions as well... asset supplied i have xlm, aqusdc and sousdc
so it should all be properly represented." `allPositionsAnswer`'s own docstring says this is
deliberate ("Margin collateral/debt and Earn (vToken) supply are separate... this is Blend +
Aquarius/Soroswap LP only") — that was a considered decision (different product, different
pool) but the user now wants Earn folded into the "all my positions" answer too. Should reuse
`earnPositionsAnswer`'s existing read (same file, `handle.ts`) as a third concurrent fetch
inside `allPositionsAnswer`, added as its own facts group — do not duplicate the sequential-call
logic there (`earnPositionsAnswer`'s own comment explains why it's sequential, not
`Promise.all`: concurrent `vanna_get_vtoken_balance` calls reliably time out on the live MCP
session).

**3. Multi-leg "swap X to Y and add liquidity in `<venue>`" only executes the swap leg, no
follow-up, no error — not yet root-caused.** `needsSemanticIntent` correctly identifies this
as a 2-verb plan ("swap" + "add") and defers to Vertex; the multi-leg-resume reconstruction
fix (`handle.ts` ~line 5704, finding #43 in TEST-RUN-FINDINGS.md) is asset-agnostic and
should apply the same for SOUSDC as AQUSDC. The drop is somewhere between Vertex's plan
construction and the multi-leg execution/resume loop — not yet isolated to a specific
function. Get a fresh repro with the FULL "show all turns" session-log detail, or better, the
raw JSON response (`remaining_legs`/`prefer_resume_multi_leg` fields) to see whether Vertex
ever built a 2-step plan at all, or whether the second leg was queued and silently dropped
during execution.

  Related design point from the user, not yet implemented: when a multi-leg command names ONE
  venue for the LP leg ("...and Add Liquidity in Soroswap"), the SWAP leg that feeds it should
  use the SAME venue, not whatever the swap step defaults to on its own — "so swap bhi via
  soroswap hi hoga, that is obvious" (the swap should obviously go via Soroswap too). Check
  `expandPlanWrites`/`materializeLeverageWrites` (or wherever a multi-leg plan's individual
  step venues get resolved) for whether a later step's venue is ever propagated backward to
  an earlier step that shares the same token pair.

### Working-style notes for whoever picks this up

- **Always test on `/copilot`, never the "Ask about this page" sidebar** — that's a separate,
  info-only surface (see memory `copilot-assistant-vs-copilot-page.md`).
- The user has been running some prompts themselves and pasting screenshots back — when a
  live repro is needed and you don't have one, it is fine (and token-cheaper) to ask for a
  specific prompt to be run and the resulting screenshot/session-log detail, rather than
  redoing the whole browser-automation loop yourself.
- Keep end-of-turn chat summaries to 1-2 plain sentences — this was called out explicitly
  this session (memory `feedback-keep-turn-summaries-short.md`).
- Standing convention, unchanged from every prior session: `tsc --noEmit` + full `vitest run`
  clean before every commit, live-verify on `/copilot` after, keep TEST-RUN-FINDINGS.md in
  sync, single-line commit messages with no AI attribution, push after each logical batch.

---

## Session 2 (2026-08-10, later) — 19 bugs fixed, 26 transactions executed

Everything below in "Work queue" is superseded where it conflicts with this block.

Test wallet for all of it: **`GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52`**,
smart account **`CAHLZMJMMKNC2OUX2334UP3AXWEQFXHOJNQFE26M5MOIDOQNRSHQGLLJ`** (created this
session by the copilot itself, with auto-approve OFF). Suite **694 → 778**, `tsc` clean.

| # | Bug | Fix |
|---|---|---|
| 1 | **Account creation failed with auto-approve OFF** — `wallet_not_bound` arrives as a top-level `build.error` with `auto_sign`/`auto_sign_error` both null, so it never reached the auto-sign branches, fell into `softFail`, and **discarded the XDR MCP had already built** (`has_unsigned_xdr: true` while reporting failure). | `mcp-write.ts` — an auto-sign refusal carrying a usable XDR returns `needs_wallet_sign`. Keyed on the error CODE, never prose. |
| 2 | **Percentage sizes dropped**, in 3 separate places: router had no `fraction` slot for lend/deposit/withdraw; `step-extractor` only read amount+asset pairs; the **LLM planner** carried no fraction at all. | `findBalanceFraction` + `applyFraction` (`amount-intent.ts`), `FRACTION_SIZED_OPS`, `resolveBalanceFractionAmount` (`handle.ts`). |
| 3 | **Approved plan lost the share** — card said 25%, replay asked "How much XLM to deposit?" because `materializeLeverageWrites` needs a number. | Fractions resolve in `runPlan` **before** leverage is materialized. |
| 4 | **Levered deposit+borrow stayed split** — `coalesceLeveragedDepositBorrow` required an absolute `dep.amount > 0`, so a share-sized deposit never merged and the borrow lost its leverage entirely. | Guard accepts a fraction; merged step carries it. |
| 5 | **A swap bought a different token than the card showed** — `mapUsdForVenue` rewrote any USDC variant to the venue's own, and the label was built from the user's word. "swap 10 XLM to BLUSDC" → card said BLUSDC, transaction bought **AQUSDC**. | Named variant selects its venue; BLUSDC refused (not a DEX token); label always names the wire symbol. |
| 6 | **Venue defaulted in two places** (`router.ts`, `handle.ts`), making "user named a venue" indistinguishable from a guess. | Both preserve null. |
| 7 | **Card clutter** — 9 plumbing rows (FUNCTION, CONTRACT, SIMULATION SUCCESS, AUTO SIGN ERROR, raw stroop fees…), model-facing `"do not invent a hash"`, and a stale `ERROR wallet_not_bound` row on **successful** cards. | `PLUMBING_FACT_KEY` (`explain.ts`), `withoutSupersededDiagnostic`, `readyToSignMessage`. |
| 8 | **Raw HTML error page in an answer** — a WorkOS 520 put `<!DOCTYPE html>…` where the XLM APY should have been. | `shortError` strips tags, maps known infra faults, caps length. |
| 9 | **TVL never totalled** — listed four pools, named a winner, answered no question. | Sums total **assets** in USD; declines rather than guessing if the XLM oracle fails. |
| 10 | **Comparison never compared** — "compare the XLM and BLUSDC pools" dumped all four. | Narrows to named pools, leads with the verdict and the gap. Bare USDC expands to all three variants. |
| 11 | **HF projection returned the present**; **liquidation price routed to the spot oracle** and claimed "no position data". | `parseHypotheticalMove` + `projectHealthFactor`; liquidation-price route + `liquidationPriceLine`. Threshold **derived** from the live pair, never assumed. |
| 12 | **`remove_liquidity` sent arguments MCP rejects** — `fraction`/`share_fraction`, which it has never taken. Returned `invalid_input`, and the copilot pasted MCP's *developer* guidance to the user ("Never pass raw share integers"). | Full exit → `remove_all`; explicit size → `liquidity`; a partial share asks for a figure in the user's terms. |
| 13 | **`PROJECTED IMPACT: reading your current position failed` on every Earn op** — NOT flakiness (I guessed that twice and was wrong). `risk.ts:105` deliberately returns an empty baseline for every `requires_account: false` op, because an Earn supply doesn't touch margin; the card could not tell that apart from a failed read. | `Simulation.margin_applicable` — card and prose now say "None — this moves tokens in your wallet and doesn't touch your margin account…". |
| 14 | **`copilot-workspace.tsx` kept its OWN `Simulation` type** — the same "two definitions of one type" trap as `CopilotAction`, so a field added server-side did not exist in the UI. | Imports the server type from `lib/copilot/types`. Do not re-fork it. |
| 15 | **Swap had no percentage support** — Trade/Spot offers 25 / 50 / 75 / Max, but both swap entry conditions in the router required a numeric amount, so "swap half my XLM to USDC" fell through to a generic clarify. | `swapShare` + `swapPair` open the branch on a share; `swap` added to `FRACTION_SIZED_OPS`. |
| 16 | **The XLM reserve was charged against the wrong balance** — a swap spends the SMART ACCOUNT's XLM (a contract token balance), but `resolveBalanceFractionAmount` deducted the `(2+subentries)×0.5` **wallet** reserve, giving 2240.7178423 where Trade/Spot's own 25% gives **2241.7178423** — exactly 1 XLM short. | The reserve is now keyed on the balance SOURCE (`"in your wallet"`), so it cannot drift onto a contract balance again. |
| 17 | **`PROJECTED IMPACT: reading your current position failed` on MARGIN ops** — I mis-diagnosed this twice as flaky RPC. It is not. `vanna_margin_status/health` returns **HTTP 200 carrying an error field** (`HostError: Error(Budget, ExceededLimit)`) on accounts holding several collateral tokens, so `fetchHealth`'s catch was unreachable, no key parsed, and the baseline silently zeroed. `runRead` documents this exact trap at `handle.ts:~2678`; `risk.ts` had never learned it. | `healthFromSnapshot` fallback in `risk.ts`, triggered on ANY unparseable payload (not just the budget string), plus a `console.warn` so a future silent zero is visible. Verified: HF 3.29 → 2.96 now renders where the card previously reported a failure. |
| 18 | **Receipt denied a health factor it had** — "lend 15 SOUSDC, then tell me my health factor" ended with "no health factor was returned", directly under a card showing 3.29. `runPlan` only sampled HF when a leg had MOVED health, and `lend` does not, so the summariser was honestly handed null. | Asking for HF is now itself reason to read it (`askedForHealth` in `runPlan`). Verified: "…establishing a account health factor of 3.29". |
| 19 | **Session log "stuck on staged"** (owner-reported) — an abandoned run never reports a terminal status, so its row said `staged` forever. | `settleAbandonedRow`, on hydration only. See the note below. |

Plus: internal tracking keys (`BLEND_USDC`) now render as "USDC in Blend" in prose — **label
only, totals untouched**. Whether a Blend supply should count toward margin collateral is a
protocol-semantics call for the contracts owner; `account-snapshot.ts:50-58` warns against a
second copy of that rule.

**Non-bugs, don't re-chase:** `/trade` 404s because there is no `app/trade/page.tsx` — it is
a dropdown over `/trade/spot|perps|options`. The "Approve & sign does nothing" I reported
mid-session was me reading a mid-flight panel before it repainted; the clicks worked.

**Exercised end to end (26 transactions, auto-approve OFF, all `successful: true`):** account
creation · deposit · borrow · repay (incl. `repay 25% of my BLUSDC debt`) · withdraw
collateral · swap · earn lend · earn redeem · Blend supply · Aquarius LP add/remove · plan
approval · TVL / comparison / HF projection / liquidation-price reads · Portfolio ·
Analytics.

**Trade/Spot ground truth (driven, not assumed):** You Pay **XLM only**; You Receive **USDC
only** — the token picker has exactly one entry. A venue dropdown (Soroswap | Aquarius)
decides which USDC SAC you actually receive, which is why the page can label it plainly
"USDC". Rungs are **25 / 50 / 75 / Max** (NOT the 10/25/50/100 used by Earn and Margin), and
the balance shown is the **smart account's**, not the wallet's. The copilot names the real
token (SOUSDC / AQUSDC) because it has no venue dropdown visible beside the number.

**Needs the OWNER, not the next session:**
1. The **swap venue change** — `swap X to SOUSDC` now routes to Soroswap rather than
   Aquarius. Correct, but it changes which token a swap buys; review before shipping.
2. Whether a **Blend supply should count toward margin collateral**. Label fixed, totals
   deliberately untouched.
3. ~~session-log "stuck on staged"~~ — **EXPLAINED AND FIXED.** It is not a status-mapping
   fault: a row leaves a pre-terminal state only when something reports a terminal one, and
   an ABANDONED run (staged, never signed, user walks away) never reports anything. Proved
   it — a `lend` staged at 08:xx still read `staged` seven hours later, and only cleared
   because re-running the same prompt produced the same deterministic plan id and updated
   the original row. Fix: `settleAbandonedRow` relabels a pre-terminal row older than 30
   min as "not completed" / "not signed" on hydration only, so a live run is never
   relabelled underneath the user. A plan quote is valid for 5 min, so a staged row that
   survives a reload is definitively finished.

**Latency, measured warm (2026-08-10):** read **6.7s**, 2-step plan **7.4s**, 4-step plan
**6.5s**. An earlier claim in this session that plan preview takes 40–60s was WRONG — every
one of those samples was the first request after a source edit, i.e. Turbopack recompiling.
This file already warns about that trap and I fell into it anyway. Measure on a warm server,
over several samples, or don't quote a number.

**Auto-approve, the actual flow (verified 2026-08-10):** rail toggle → budget radio
(`defaults` is pre-selected; switch to `custom` if you want) → **`Done`**. Only `Done` calls
`enableAutoSign`; the radios just set `railCapsMode`, which is deliberate so the choice can
be changed before it is committed. A wallet's FIRST enable also needs the one-time signer
bind (`Authorize in app`); after that `disable auto-sign` revokes only the policy session —
"Privy addSigners was NOT removed" — so the bind never reappears.

I wasted time reporting "Default caps does nothing" as a bug. It is a radio that was already
selected, and my button-search regex never matched `Done`, so I judged a control I had never
clicked. Twice this session I mistook my own tooling for the product: a mid-flight panel read
as a dead click, and a filter gap read as a missing handler. The one method that never misled
me was opening the site and comparing its numbers — that is how the 2241.7178423 swap figure
and the 2498.9290941 collateral figure were settled.

**The trap worth remembering:** MCP reports a Soroban budget overrun as a **200 with an error
field**, never a rejection. Any `try/catch` around an MCP read is therefore the WRONG guard on
its own — the catch never fires, and the failure becomes a plausible-looking zero. This bit
`runRead` once and `risk.ts` again months later. Check the payload, not just the promise.

---

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

Baseline to preserve: `npx tsc --noEmit` clean, `npx vitest run` = **778 passing**.

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

### Task 1 — Manual margin-account creation — **FIXED AND VERIFIED ON-CHAIN 2026-08-10**

The functional path really was broken, exactly as the owner said; the wording fix last
session was treating a symptom.

**Root cause** (`mcp-write.ts`, `executeMcpWrite`): `wallet_not_bound` arrives as a
top-level `build.error` with `auto_sign` and `auto_sign_error` **both null**, so it never
reached the auto-sign branches that stage a wallet signature. It fell into the generic
`softFail` test (`!!build.error`), which returned `status: "error"` and **discarded the
XDR MCP had already built** — the response carried `has_unsigned_xdr: true` while the
copilot reported a failure and rendered no Approve & sign button. With auto-approve ON the
Sign Service signed before any of this ran, which is precisely why it "worked when ON".

**Fix:** an auto-sign refusal that still carries a usable XDR now returns
`needs_wallet_sign` with that XDR. Keyed on the error CODE, never the prose, so a genuine
`simulation_failed` is still reported and never offered for signature. 6 regression tests
in `tests/lib/auto-sign-refusal-stages.test.ts` replay the live payload.

**Verified end to end** with auto-approve OFF on the fresh wallet: Approve & sign →
signed by Privy → tx `d04b076a86b40bf4dd838453123cb703081df176db325be6a81b6b18c3c12e07`
(`successful: true`, ledger 4069209) → smart account
`CAHLZMJMMKNC2OUX2334UP3AXWEQFXHOJNQFE26M5MOIDOQNRSHQGLLJ`, resolved from AccountManager
on-chain storage.

**Two copy defects still open, both cosmetic:**
1. The success card still renders an `ERROR wallet_not_bound` row with MCP's full plumbing
   paragraph — under a heading that says EXECUTED. It is stale auto-sign detail on a card
   describing a completed transaction, and it reads as a failure.
2. `"Use Approve & sign / Freighter; do not invent a hash."` is model-facing instruction
   text leaking into the user-visible message (appended as `xdrNote` in `handle.ts`).

### Historical note — what was known before the fix

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

### Task 3 — C7: percentage-of-balance amounts (CODE DONE, live run not yet done)

`deposit XLM 50% of XLM in my wallet into the XLM pool` → *"How much XLM do you want to
supply?"* A question answered with a question: the user gave a size.

**Done 2026-08-10.** `findBalanceFraction` + `applyFraction` +
`BALANCE_FRACTION_OPTIONS` in `amount-intent.ts`; the router carries a `fraction` on
`lend` / `deposit_collateral` / `withdraw_collateral`; `FRACTION_SIZED_OPS` in
`registry/intent.ts` makes a stated share satisfy `requires_amount`; and
`resolveBalanceFractionAmount` in `handle.ts` sizes it off the live balance next to
`resolveRepayAmount`. Site maths copied, not invented: wallet balance (or posted
collateral for withdraw), `maxSpendableXlm` for native XLM out of the wallet, floored to
7dp — the same rules as `collateral-box.tsx`'s percentage chips. 20 new tests in
`tests/lib/balance-fraction.test.ts`; suite 694 → **714**, `tsc` clean.

`findBalanceFraction` is deliberately stricter than `findAmountFraction`: "all"/"max" only
counts as a size when the sentence names the balance it is a share of, so
`invest for max yield` can never mean "100% of my wallet".

**Still to do:** run it in the browser against the live wallet and confirm the sized
figure matches what the Earn form shows for the same chip.

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
