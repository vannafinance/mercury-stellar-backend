# Copilot test run — what needs attention

2026-08-12 · branch `copilot-ui-rewire` · localhost, auto-sign ON, one funded W2 wallet.
Against `note.txt`. Only open items listed.

| # | Item | Severity | Owner |
|---|---|---|---|
| 1 | Pool stats named the wrong pool — **FIXED and verified on all three pools** | P0 (closed) | — |
| 2 | A single-leg deposit routed as `multi_leg` and errored | High | router |
| 3 | `how much is AQUA` → oracle error — **cause found: AQUA has no oracle feed** | Medium | product call |
| 4 | Script sections 10 + 12 never run — both gate ship per §19 | Blocks ship | QA |
| 5 | `note.txt` §18 says 778 tests; it is 790 | Doc fix | QA |
| 6 | 66 dependabot vulns (32 high) on default branch | Before handover | infra |

---

## 1. Pool stats named the wrong pool  (P0 — FIXED, verified)

**Verified after the fix:**

```
BLUSDC pool stats  ->  pool symbol: BLUSDC  ·  "The BLUSDC Vanna earn pool offers a supply APY of 17.60%…"
AQUSDC pool stats  ->  pool symbol: AQUSDC  ·  "The AQUSDC earn pool currently offers a supply APY of 9.21%."
SOUSDC pool stats  ->  pool symbol: SOUSDC  ·  "The SOUSDC earn pool currently has a supply APY of 0.08%…"
```

`tsc` clean · 790 tests passing. R-11 / R-12 / R-13 should now pass — please re-run them.

<details>
<summary>What was wrong, and why the first two attempts did nothing</summary>


**One cause behind R-11, R-12, R-13 and the note "mostly the pool stats are incorrect".
The numbers were right; the name on them was wrong.**

`BLUSDC pool stats` returned:

```
intent.slots.symbol = "BLUSDC"    <- resolved variant
data["pool symbol"] = "USDC"      <- MCP wire symbol
headline            = "The USDC Vanna earn pool offers a 17.16% supply APY…"
facts               = total liquidity 1,536.5528 USDC
```

BLUSDC, AQUSDC and SOUSDC are three separate pools that **all** report
`pool symbol: "USDC"` on the wire, so the wire symbol cannot identify the pool and all
three answers looked identical.

**Two separate mistakes, both silent — worth knowing because neither threw an error:**

1. Read `routed.args.symbol` — the router's *pre-normalisation* guess. `buildToolArgs()` is
   what upper-cases the symbol and applies the `"USDC"` fallback, and its output
   (`built.args`) is what actually reaches the MCP call and `intent.slots`.
2. Read the key `"pool symbol"` (with a space). The MCP sends `pool_symbol`; `factsForUi()`
   is what converts underscores to spaces for display. On the raw payload that key does not
   exist, so the comparison matched nothing.

Because of (2) the headline still changed occasionally — that was model variance, not the
fix working. It was only deterministic once both were corrected.

**Fix:** reads `built.args.symbol` and checks `pool_symbol` / `pool symbol` / `symbol`. It
does **not** relabel from the user's word — that is the old P0 where a swap card said
BLUSDC while buying AQUSDC. Narrow by design: only substitutes when the stored value is
exactly `USDC` and the resolved variant is one of the three.

</details>

## 2. Single-leg deposit routed as multi_leg, and failed

Two session-log rows, same prompt, minutes apart:

```
deposit 5 XLM as collateral   ERROR     multi_leg                  8m
Deposit 5 XLM collateral      executed  vanna_deposit_collateral   7m
```

Same intent, two different routes, one failed. Looks reproducible. Router-side, not UI.
Not investigated.

## 3. `how much is AQUA` → oracle error  (root cause found in the MCP repo)

> "The price for AQUA is currently unavailable due to an oracle contract error."

Traced in `vanna_mcp/vanna-mcp/vanna_core/contracts/oracle.py`:

```python
SYMBOL_CANONICALIZATION = {          # AQUA is NOT here
    "BLUSDC": "USDC", "AQUSDC": "USDC", "SOUSDC": "USDC",
    "AQUARIUS_USDC": "USDC", "SOROSWAP_USDC": "USDC",
    "BLEND_XLM": "XLM", "BLEND_USDC": "USDC",
}
LP_SYMBOLS = {"AQ_XLM_USDC", "SS_XLM_USDC", "AQ_XLM_AQUA", "AQ_XLM_USDT"}   # nor here
```

So `AQUA` is neither canonicalised nor recognised as a feed-less token. It goes to the
contract raw as `get_price_latest("AQUA")`, the call fails, and the wrapper reports
`ContractCallError: Oracle: price not found for symbol 'AQUA'`. The copilot then surfaces
that as "oracle contract error" — which reads like an outage, not like "this asset has no
feed".

Supporting evidence: the MCP's own prior test-matrix run (`scripts/sanujit_matrix_results.json`)
only ever priced **XLM, USDC and SOUSDC**. AQUA appears in it solely as an LP pair
(`XLM/AQUA`), never as a priced asset.

**Decision needed — this is a product call, not a bug fix:**

- If AQUA genuinely has **no** oracle feed → `note.txt` §0.6 is wrong ("AQUA and EURC are
  priceable"), and the MCP should declare AQUA feed-less alongside `LP_SYMBOLS` so the user
  gets *"AQUA has no price feed"* instead of a generic contract error.
- If AQUA **should** be priceable → the feed has to be added to the oracle contract
  on-chain. That is not an MCP change.

Either way the honest-error improvement in `oracle.py` is a small, safe change and worth
doing on its own. Also explains R-06's partial failure.

## 4. Untested sections that block sign-off

Not run: **6** (account lifecycle), **9** (risk gate), **10** (plan integrity), **12**
(prompt injection), **16** (resilience), **17** (observability).

§19 requires **10 and 12** to pass before ship — neither has been touched.

Wallet states **W0 / W1 / W3** were never prepared, so every `[W0]` / `[W1]` / `[W3]` row in
the script is still open. Everything above ran on a single funded W2.

---

## Fixed and verified this run

- **Follow-up ignored the asked amount** — "Can I borrow 20 USDC?" offered "Borrow 2 USDC"
  (`FOLLOW_UP` was a hardcoded map). Now derived from `intent.slots`; clicking it loads the
  composer instead of firing a write.
- **Long fact rows clipped their figure** — `COLLATERAL LEFT BEFORE LIQUIDATION` showed
  `1…`; now spans the full row and reads `1,242.1018`.
- **`REASON no_active_session`** — machine status code no longer shown as a user-facing fact.

## Passed — worth knowing

- **Multi-leg write: 4 of 4 settled**, "Nothing is left in flight", and **each leg carried
  its own tx hash** — that is script item P-05 passing:
  `00082288c6…048707` (lend 20 XLM) · `c5b516d9c8…e9faf9` (deposit 10 BLUSDC) ·
  `05732813f4…6946c4` (borrow 10 BLUSDC) · `e6a19a5ce0…115a24` (supply 9.965 to Blend)
- **The old "session log stuck on staged" bug did not reproduce.** Row closed as
  `status: executed`, all four legs `done`, merged into one parent row. An earlier run of 13
  signed writes also closed correctly — treat as unreproduced and re-confirm with the owner
  before spending time on it.
- Reads fine: can-borrow, health factor, 15/15 protocol addresses, XLM price.
- With auto-sign OFF the write gate held correctly (staged → `Approve & sign`).
- `tsc` clean · 790 tests passing.
