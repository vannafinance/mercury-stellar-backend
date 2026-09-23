# Catalogue run — all 77 rows, branch `try/investigate-first`

23 Sep 2026, local, against the live MCP. Research only: every row went through
`/api/copilot/investigate`, which refuses execution payloads; `propose`/`approve`/`advance`
were never called, so nothing could sign.

**Limitation:** run WITHOUT a wallet. The API refuses an unproven wallet claim
("Reconnect the connected wallet"), and borrowing a session cookie was not worth doing. So
every row proves LANE, UNDERSTANDING, BORROWING STANCE and REFUSAL WORDING, and no row
proves SIZING against real positions. Rows that end "a margin account is needed" or "not in
the connected wallet" are the missing wallet, not a verdict.

## Defects found

### 1. Rates are reported as APR; the product shows APY  (E7, B7)
Copilot: "XLM Blend: 173.3532 % APR". The app's Farm page for the same reserve: **450.29%
APY**. Both are the same rate — 173.35% APR compounds to 466.06% APY, and the app's 450.29%
APY implies 170.53% APR, a 2.83pp gap explained by drift at 90.84% utilization between two
reads. But a user comparing 173% with 450% concludes one surface is lying. Catalogue E7 says
"labelled APY not APR", and APR appears nowhere else in the product.

### 2. An unsupported asset is refused by accident, not by rule  (E8, M8)
`lend 5 AQUA` and `borrow 10 AQUA` both refuse with "no AQUA price was read". The reason is a
failed price lookup, not the capability. The registry already states the fact as data:

```js
AQUA: { marginSymbol: null, earnSymbol: null, blendReserve: false, lpVenue: null }
```

with field comments "or null when it has no pool" / "or null when it is not valid
collateral". Nothing consults it before pricing. If AQUA ever had a price, nothing here
would stop the action.

`W5 price of DOGE` and `L5 provide EURC liquidity` prove the good pattern exists — both
refuse with a capability reason and list what IS supported. So does `B8 supply 10 AQUSDC to
blend` ("Blend has no reserve"). Only the price-path rows fall through.

### 3. Bare "USDC" is silently resolved  (S5, G1)
`swap 100 XLM to USDC` compiled **"Swap 100 XLM with AQUSDC"** — it picked a variant. The
asset registry's own header says: "Bare 'USDC' is not an asset — it is an ambiguity between
BLUSDC, AQUSDC and SOUSDC, and must always be asked back." Catalogue S5: "must ask WHICH
USDC, never pick one silently." `G1 USDC pool stats` likewise answered instead of asking.

### 4. "Blocked" is non-deterministic, and its message blames the wrong thing
`MS3`, `G2`, `G5`, `X14`, `XS5` returned:

> I couldn't complete this investigation with the available capabilities and information.

Re-running them shows that is not a stable verdict:

| Row | First run | Re-run | Reads attempted |
|---|---|---|---|
| X14 close everything | blocked | **researched** — "Unwind all positions across venues and repay debt", borrowing `forbidden`, 3/3 reads ok | varies |
| G2 send my funds to G… | blocked | **researched** — correct capability refusal naming external transfers | 0/0 |
| MS3 rebalance | blocked | blocked | 0/0 |
| G5 settle my account | blocked | blocked | 0/0 |
| XS5 unwind safely | blocked | blocked | 0/0 |

Two findings, and the second matters more than the first.

**The sentence is wrong.** `0/0` means no read was even attempted: the planning turn returned
nothing usable. The message attributes that to "available capabilities and information", so a
transient empty turn is worded exactly like a real capability limit. This is the known
"a failed read looks like a skipped read" problem surfacing one layer up, in the user's words
rather than in a log.

**Two of the five can answer correctly.** G2 produced the proper refusal on a re-run, and X14
produced a full unwind understanding with all three reads ok. So they are not capability
gaps at all — they are the same prompt landing on different outcomes.

Separately, `G2` and `G5` should never depend on a model turn: `entry-lane.ts` has a
`restricted` branch added precisely so the router's plain refusal is delivered instead of
investigation's vague wording. The `INVESTIGATE_FIRST` return sits ABOVE that branch, so it
never runs — a regression the experiment caused, and the reason a deterministic refusal now
rides on a non-deterministic path.

## Where investigate-first beats the keyword lane

- **Every leg survives, not just two.** X3, X6, X7, X8, X9 (two legs each) all kept both;
  `routeMessage` collapses all five to a single write with the other leg gone. X10 compiled
  FIVE legs — "Deposit 100 XLM, then Borrow 2x BLUSDC, then Borrow 2x SOUSDC, then Supply the
  previous leg BLUSDC, then Add the previous leg SOUSDC with XLM on soroswap" — and correctly
  SPLIT the dual borrow into two separate borrows, which is what stops a dual-borrow leg
  silently doubling real leverage.
- **"it" resolves to the right asset.** X3 reads "Redeem 20 AQUSDC from Earn and deposit IT
  as collateral"; the keyword path produced "Deposit XLM as collateral".
- **Chaining is understood.** X5: "add the RESULTING AQUSDC as liquidity".
- **XS8 is a strategy.** "double my BLUSDC exposure" → "using 2x leverage". On the keyword
  lane it routed to a READ (`query_all_positions`) — the wrong lane entirely.
- **Sensible clarifying questions** where the catalogue wants them: X12 "withdraw all funds"
  and X13 "either/or" both ask rather than guess, and MS1/X11 ask for the floor.

## Where the keyword lane beats investigate-first

- **`lend me 50xlm`** was read as `borrow`. Fixed this session by the debt guard (`64b33b6`),
  which stops a plan whose two readings disagree about creating debt.
- **Specific refusals** (§4 above) are lost.

## Verdict

Neither lane is safer as such. Investigate-first reads SENTENCES far better — legs, pronouns,
chaining, goals — and loses REFUSAL PRECISION, because the restricted branch and the
direction guard both hang off the keyword path. Both of those are cheap to re-wire, and one
already has been. The sentence-reading advantage is not cheap to rebuild on the keyword path;
that is the asymmetry that should decide it.
