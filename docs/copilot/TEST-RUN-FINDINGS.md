# Copilot test run — what needs attention

2026-08-12 · branch `copilot-ui-rewire` · run on localhost, auto-sign ON, one funded W2 wallet.
Against `note.txt`. Only open items are listed.

| # | Item | Severity |
|---|---|---|
| 1 | Pool stats name the wire symbol, not the pool — fix committed but NOT working | P0 |
| 2 | A single-leg deposit routed as `multi_leg` and errored | High |
| 3 | `how much is AQUA` → oracle error | Medium — decide which side is wrong |
| 4 | Sections 10 + 12 never run — both gate sign-off per §19 | Blocks ship |
| 5 | `note.txt` §18 says 778 tests; it is 790 | Doc fix |
| 6 | 66 dependabot vulns (32 high) on default branch | Before handover |

---

## 1. Pool stats name the wrong pool  ← start here

**One cause behind R-11, R-12, R-13 and "mostly the pool stats are incorrect".
The numbers are right; the name on them is wrong.**

`BLUSDC pool stats` returns:

```
intent.slots.symbol = "BLUSDC"    <- router's resolved variant
data["pool symbol"] = "USDC"      <- MCP wire symbol
headline            = "The USDC Vanna earn pool offers a 17.16% supply APY…"
facts               = total liquidity 1,536.5528 USDC
```

BLUSDC, AQUSDC and SOUSDC are three separate pools that **all** report `pool symbol: "USDC"`.
The wire symbol cannot identify the pool, so all three answers look identical.

A fix is committed in `handle.ts` — it uses `routed.args.symbol` (the router's resolution
that also chose which pool to read), **not** the user's word, so it does not repeat the old
P0 where a swap card said BLUSDC while buying AQUSDC.

**It did not take effect when tested** — all three prompts still returned `pool symbol: USDC`.
Two candidates:

1. **Check this first:** `query_pool_stats` may have its own response branch, and the edit
   landed on the generic read path. `computeMarginSnapshot` has such a branch at
   `handle.ts:2495`, so the pattern exists in that file.
2. Dev server did not recompile (it went stale twice this session).

Re-test:

```bash
for p in "BLUSDC pool stats" "AQUSDC pool stats" "SOUSDC pool stats"; do
  curl -s -X POST http://localhost:3000/api/copilot -H "content-type: application/json" \
    -d "{\"user_id\":\"guest\",\"message\":\"$p\"}" | head -c 300; echo; done
```

Pass = each headline and every fact unit names the pool that was asked for.

## 2. Single-leg deposit routed as multi_leg, and failed

Two session-log rows, same prompt, minutes apart:

```
deposit 5 XLM as collateral   ERROR     multi_leg                  8m
Deposit 5 XLM collateral      executed  vanna_deposit_collateral   7m
```

Same intent, two routes, one failed. Looks reproducible. Routing, not UI. Not investigated.

## 3. `how much is AQUA` → oracle error

> "The price for AQUA is currently unavailable due to an oracle contract error."

Honest (invents nothing), but `note.txt` §0.6 says AQUA is priceable — so either the oracle
has no AQUA feed and §0.6 needs fixing, or the feed is broken. MCP/oracle side, not UI.
Also explains R-06's partial failure.

## 4. Untested sections that block sign-off

Not run: **6** (account lifecycle), **9** (risk gate), **10** (plan integrity), **12**
(prompt injection), **16** (resilience), **17** (observability).

§19 requires 10 and 12 to pass before ship — neither has been touched.

Wallet states **W0 / W1 / W3** were never prepared, so every `[W0]` / `[W1]` / `[W3]` row in
the script is still open. Only a funded W2 was used.

---

## Fixed this run (no action needed)

- **Follow-up ignored the asked amount** — "Can I borrow 20 USDC?" offered "Borrow 2 USDC"
  (`FOLLOW_UP` was a hardcoded map). Now derived from `intent.slots`, and clicking it loads
  the composer instead of firing a write.
- **Long fact rows clipped their figure** — `COLLATERAL LEFT BEFORE LIQUIDATION` showed `1…`;
  now spans the full row and reads `1,242.1018`.
- **`REASON no_active_session`** — machine status code no longer shown as a user-facing fact.

## Passed, worth knowing

- **Multi-leg write, 4 of 4 settled**, "Nothing is left in flight" — and **each leg carried
  its own tx hash**, which is script item P-05 passing:
  `00082288c6…048707` (lend 20 XLM) · `c5b516d9c8…e9faf9` (deposit 10 BLUSDC) ·
  `05732813f4…6946c4` (borrow 10 BLUSDC) · `e6a19a5ce0…115a24` (supply 9.965 to Blend)
- **The old "session log stuck on staged" bug did not reproduce.** Row closed as
  `status: executed`, all four legs `done`, merged into one parent row. An earlier run of 13
  signed writes also closed correctly — treat it as unreproduced and re-confirm before
  spending time on it.
- Reads fine: can-borrow, health factor, 15/15 protocol addresses, XLM price.
- With auto-sign OFF the write gate held correctly (staged → `Approve & sign`).
- `tsc` clean, 790 tests passing.
