# Handover — swap quoting, price impact, and accepted slippage

**For:** Aditya. **From:** Sanujit. **Date:** 16 Sep 2026.
**Branches:** MCP `feat/mcp-swap-pool-quoting` (new, pushed, no PR yet) · app `feat/copilot-finetune` (PR #59, pushed to `41d5328`).

Swaps in the copilot did not work, for five separate reasons stacked on top of each
other. All five are fixed and pushed. Two known problems are left, one of which is a
money bug in a path nobody has exercised yet — read §5 before enabling Soroswap LP.

The rule we worked to is the existing one: **a live failure → its reason from the log →
a fix reproduced through the copilot against the MCP running locally → then a PR.** Every
run is recorded verbatim in `PROMPT-LIBRARY.md`.

---

## 1. What was broken, in the order we hit it

| # | Symptom the user saw | Actual cause |
|---|---|---|
| 1 | "The tool response could not be confirmed" on every swap | The app stopped wrapping `vanna_swap` in `{action, kwargs}` (15 Sep, `f58897b`); the MCP's composites surface still registered it as a dispatcher, so a flat call failed schema validation. Nobody had changed the other side. |
| 2 | "swaps are paused on the router-selected Aquarius pool" | `swap_killed`, from Aquarius's **off-chain** AMM API, was treated as a hard refusal in three places. The chain disagrees — see §2. |
| 3 | "Swap 100 XLM for at least 17.4469985 SOUSDC" against a pool paying 7.49 | Soroswap swaps were sized from the **oracle** (what the pair is worth) rather than the pool (what it will pay). There was no Soroswap reserves read to size from. |
| 4 | "the soroswap pool's live on-chain reserves were unavailable" — right after a successful read | `compactData` is an allowlist whose fallback is `{}`. Neither pool capability had a branch, so a sealed pool read arrived empty on the turn that needed it. This also silently affected **Aquarius** all along. |
| 5 | Card said "with explicit slippage acceptance", then refused for slippage | `wrapComplete` copies the model's fields into `goal` **by name**, and `slippageAccepted` was not in the list. |

**The pattern worth taking away:** in 1, 4 and 5 — and in the exact-output bug (§4) — the
model understood the user correctly and a **hand-maintained list in the plumbing silently
discarded it**. A regex keyword list, an allowlist with a `{}` fallback, a copy list. Each
failed identically: the feature looked wired end to end, and something in the middle
quietly answered "nothing". Where we found one of these we replaced it with a structural
field the model fills in, and pinned the hop with a test.

## 2. `swap_killed` is not what the chain enforces

This is the one worth checking yourself before trusting it.

With the flag `true` on the router-selected XLM/USDC pool:

- the pool's own `estimate_swap` answered normally (10 XLM → 0.1182876 USDC)
- our `AccountManager.execute` transaction **simulated successfully**
- the **website's** Trade › Spot page settled a real swap on that same pool:
  XLM `36571.32 → 36561.32` (−10), AqUSDC `5003.10 → 5003.22` (+0.12) — matching the
  pool's quote exactly

Verified independently of our code with a plain `curl` against
`amm-api-testnet.aqua.network/pools/CD3LFMML…/` — the flag is genuinely set, and swaps
still settle. It is surfaced as a note on the card now, not a refusal.

The copilot was refusing swaps the chain accepts, which is why it looked broken next to
the site's own swap page.

## 3. How a swap is quoted now

One rule: **ask the venue, never the oracle.** The oracle is only used for USD valuation
and for price impact.

- **Aquarius** — mirrors `AquariusService.getSwapQuote`, which is what the working UI
  does: ask **every** pool the router has for the pair via that pool's own
  `estimate_swap`, take the best output, and route the write to the pool that produced it
  (Aquarius resolves a pool from `(tokens, fee)`, so the winning pool's fee becomes
  `fee_fraction`). Asking the pool means a **concentrated-liquidity** pool quotes
  correctly without us implementing tick math.
- **Soroswap** — `router_get_amounts_out`, the same call the swap page uses. New read
  `vanna_get_soroswap_pool_stats` (exposed as `vanna_farm_lp · soroswap_stats`) returns
  the pair's reserves in the **same envelope** as the Aquarius read, so one caller-side
  formula prices either venue.
- **A pool that cannot be quoted is refused by name.** Never priced from an oracle ratio,
  which knows nothing of pool depth.
- **A floor above the venue's own quote is refused**, on both venues, whoever supplied it.
  That is the backstop that caught #3 above.

The Soroswap **fee is derived, not assumed**: the pair exposes no fee getter, so one
router quote plus the reserves determines the fee actually charged
(`a(1-f) = out·reserve_in / (reserve_out − out)`). Resolves to 0.0030 on testnet, and
would track a change on their side. Reserves + that fee reproduce
`router_get_amounts_out` to within one native unit (rounding direction only).

## 4. Exact output — "give me 15 SOUSDC"

The write API takes an input and a floor, so the venue is asked what input delivers the
requested output:

- **Soroswap:** `router_get_amounts_in` — the exact inverse, one call.
  Verified: 2 SOUSDC needs **26.7853782 XLM**.
- **Aquarius:** no inverse, so its own forward quote is inverted numerically (seed from
  the pool's rate, step until the quote covers the target; monotonic, converges in a few
  calls, and every step is the pool's arithmetic).
  Verified: 0.5 AQUSDC needs **42.3646182 XLM**.

The caller's exact figure becomes the floor, so an input that falls short **reverts**
rather than underfilling.

Detection of this intent used to be a regex over the model's prose for
`receive|get|for at least`. "give me 15 SoUSDC" was not in that list, so it silently
swapped **15 XLM** instead — a confidently wrong, auto-signed trade. That is now a
structural field, `sizing.amountAsset: "asset" | "assetOut"`, and the regex is deleted.

## 5. ⚠️ The decimals bug — read this before enabling Soroswap LP

`TOKEN_DECIMALS` says **6** for the USDC family. Every USDC-family SAC on this network
reports **7** — verified by calling `decimals()` on SOUSDC, AQUSDC, USDC and BLUSDC.
`PROMPT-BATTERY.md` already recorded this discrepancy against the Notion asset reference.

`min_liquidity_out` **is** the on-chain slippage floor. Built at 6 decimals it is **ten
times weaker** than the caller asked for — effectively unprotected — and an exact-output
size comes out ten times too small. Swaps now resolve decimals from the token contract
itself (cached per symbol+venue), which also retired a hardcoded `{XLM, USDC, AQUSDC}`
exception that existed to paper over the same wrong table.

**`farm_tools`' `add_liquidity` still sizes from `TOKEN_DECIMALS` and has the same tenfold
exposure.** It is untouched. The blocker that made Soroswap LP unavailable (no live
reserve read) is gone as of `7e9aa26`, so LP is now *tempting* to enable — **fix the
decimals there first**, or it ships a known money bug into a fresh path.

The price-impact number is what surfaced this: a sized exact-output swap reported −325%
impact, which is only possible if the amounts and the prices disagree.

## 6. Price impact, and who may accept it

Computed as the website's own swap card does — `(in_usd − out_usd) / in_usd` against
oracle prices — and returned with the transaction. Bands: **2%** say what it costs,
**10%** never auto-sign. An unreadable price reports `unknown`, never zero: no-warning
and no-data must not look alike.

An auto-sign cap bounds **size**, not **price**. A $1.76 trade returning $0.05 sits far
under any cap and used to execute with no click at all.

A user may accept a bad fill, and that acceptance is now honoured — but only from their
own words. `goal.slippageAccepted = {accepted, sourceQuote}` mirrors `healthFactorFloor`,
and `anchoredSlippageAccepted` requires the quote to appear **verbatim** in a message the
user actually sent. A paraphrase fails; the model quoting its own sentence fails;
agreement inferred from impatience or from the size of the amount fails. Four of the nine
tests exist only to prove consent cannot be fabricated. Everything else about a swap can
be re-derived — agreeing to lose money cannot.

With it: the fill is sized, **re-quoted at approval** (the floor becomes the fresh quote,
not a stale number), and executed. `staleSwapFloor` now re-quotes **both** venues; a
Soroswap leg previously skipped it entirely and carried its plan-time floor to signing.

Note we kept a floor rather than sending none. "Any price" with no floor hands the fill to
whoever moves the pool next in the same ledger.

## 7. Commits

**MCP** — `feat/mcp-swap-pool-quoting` (pushed; no PR opened yet)

| Commit | What |
|---|---|
| `877c88b` | Aquarius quoted from live pool balances; floor in native units |
| `20ef7d7` | composites-only `vanna_swap` is the flat tool, not the `{action,kwargs}` wrapper |
| `e9989c0` | every Aquarius pool quoted via its own `estimate_swap`, best wins |
| `a229ee0` | exact-output, price impact, and the decimals fix (§5) |
| `a363b53` | Soroswap quoted from its router; unreachable floors refused |
| `7e9aa26` | Soroswap reserves read, fee derived from the router |
| `35d80be` | `acknowledged_price_impact` |

**App** — `feat/copilot-finetune` (PR #59), pushed to `41d5328`

| Commit | What |
|---|---|
| `0318db0` | `swap_killed` is not a refusal (§2) |
| `1d3a778` | Soroswap swaps sized from the pool, not the oracle |
| `a017871` | accepted slippage: sized, re-quoted, executed (§6) |
| `177921e` | a sealed pool read stays quotable (§1 #4) |
| `aafffac` | the acceptance survives `wrapComplete` (§1 #5) |
| `41d5328` | PROMPT-LIBRARY entries + corrected battery coverage |

## 8. Open, in order

1. **`farm_tools` `add_liquidity` decimals** (§5). Money bug. Do this before LP work.
2. **7 app tests fail** on behaviour deliberately changed today — the `swap_killed`
   refusal, Aquarius-only exact-output, three exact-output sizing tests, and a catalog
   assertion touched by the new read. They pin the old rules and need rewriting against
   the evidence here, the way the MCP-side tests were.
3. **No swap has settled through OUR path** on Aquarius. Simulation passes and the
   website settles on the same pool, but that gap is unproven. First live run should be
   **1 XLM, not 100**.
4. **`1d3a778` mixed in uncommitted work that was not mine** — `capacity.ts`,
   `pool-quote.ts`, `allowlist.ts` and part of `service.ts` were swept in by a broad
   `git add`. Unpushed at the time, pushed now. Split it if you want clean authorship.
5. **Open a PR for `feat/mcp-swap-pool-quoting`**, and note it carries the three
   previously-local integration commits beneath it (`3dd000d` and below).
6. **Deploy.** The `{action,kwargs}` bug (§1 #1) was live on hosted too, since hosted also
   runs the composites surface. Merging is not enough.

## 9. Environment notes that cost us time

- **Two Next dev servers** writing one `.next` corrupts the route manifest — every route
  404s while `/` still serves. Stopping a backgrounded `npm run dev` on Windows does not
  always kill the child `next dev`. Check for orphans before debugging a 404.
- **`Sending your request` with nothing in the server log** = the request never left the
  browser. Chrome's 6-connections-per-origin limit; close other `localhost:3000` tabs.
  Confirm in DevTools → Network → Timing → "Stalled".
- **~12s of every local turn** is the identity-token cold mint
  (`fix/mcp-identity-token-mint-cache`, closed as local-loop-only). Hosted never hits it.
- Run the app with `| tee -a copilot-dev.log`; without it the log goes stale and reads
  from it are hours old.
