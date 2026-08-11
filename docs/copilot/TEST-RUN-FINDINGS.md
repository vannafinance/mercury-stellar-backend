# Copilot test-run findings — 2026-08-12

Against `note.txt` (MANUAL END-TO-END TEST SCRIPT), branch `copilot-ui-rewire`,
commit `94c489f` pushed to `origin`. Driven on `localhost:3000` (dev), wallet
`GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52`, auto-sign ON.

Everything below was observed live, not inferred.

---

## 1. FIXED and verified

### Follow-up suggestion ignored the asked amount (owner's "Test #4")
"Can I borrow 20 USDC?" answered yes, then offered **"Borrow 2 USDC"**.

Not truncation. `FOLLOW_UP` in `copilot-workspace.tsx` was a static map with
`vanna_can_borrow: "Borrow 2 USDC"` hardcoded — it never read the question, and 2 is
what the canned example happened to say. Now derived from `intent.slots`
(`{symbol, amount}`) via `followUpFor()`, falling back to the canned string when a read
named no amount.

Also changed: clicking it now **loads the composer instead of running**. The suggestion
is a write carrying the user's amount, and with auto-sign ON one click was one borrow at
whatever size the label showed.

Verified: label `Borrow 20 USDC`, composer fills, focus moves, nothing executes.

### Long fact rows clipped their own figure
`COLLATERAL LEFT BEFORE LIQUIDATION` sat in a half-width cell of a two-column grid with a
`shrink-0` label, so it ran into the next column and its value truncated to `1…`. Rows with
a label over 22 chars now span the full row: value reads `1,242.1018`. Fixed in both
`FactsGrid`/`Row` (copilot-workspace) and the answer card's figures grid.

### Machine status codes shown as user-facing facts
The staged deposit gate showed `REASON  no_active_session` beside the amount. The key
cannot go on the plumbing denylist because the same field carries real prose on a read
("Borrowing 20 USDC is permitted: it passes the gross-asset check…"), so the **value**
decides: a lone snake_case token with no whitespace is a code. `isStatusCode()` in
`explain.ts`, scoped to `reason` only. Verified: row gone, `AMOUNT 5 XLM` and
`wallet sign required` intact.

---

## 2. UNVERIFIED FIX — needs a look before trusting it

### Pool stats name the wire symbol, not the pool (R-11 / R-12 / R-13, P0 class)
This is the single cause behind three of the owner's ❌ marks and the note
"mostly the pool stats are incorrect". **The numbers are right; the name on them is wrong.**

`BLUSDC pool stats` returns:

```
intent.slots.symbol    = "BLUSDC"     <- router's RESOLVED variant
data["pool symbol"]    = "USDC"       <- MCP wire symbol
headline               = "The USDC Vanna earn pool offers a 17.16% supply APY…"
facts                  = total liquidity 1,536.5528 USDC, total borrows 3,588.9961 USDC
```

BLUSDC, AQUSDC and SOUSDC are three separate pools that all report `pool symbol: "USDC"`.
So the wire symbol cannot identify the pool, and all three answers are indistinguishable.

A fix is committed in `handle.ts` (substitutes the resolved variant when the wire value is
exactly `USDC` and the variant is one of the three). It is written to respect the existing
P0 lesson — it uses `routed.args.symbol`, the router's resolution that also chose which pool
to read, **not** the user's raw word (a swap card once said BLUSDC while buying AQUSDC).

**But it did not take effect when tested.** After the edit, all three prompts still returned
`pool symbol: USDC`. Two candidate causes, untested:

1. The dev server did not recompile. This server went stale on `globals.css` twice in one
   session, so it is a real possibility — restart and re-run before anything else.
2. `query_pool_stats` has its own response-assembly branch and the edit landed on the
   generic read path. `computeMarginSnapshot` has such a branch (`handle.ts:2495`), so this
   pattern exists in the file.

Check (2) first — it is cheap and it decides whether the committed code is live or dead.

Re-test with:

```bash
for p in "BLUSDC pool stats" "AQUSDC pool stats" "SOUSDC pool stats"; do
  curl -s -X POST http://localhost:3000/api/copilot -H "content-type: application/json" \
    -d "{\"user_id\":\"guest\",\"message\":\"$p\"}" | head -c 400; echo; done
```

Pass = each headline and every fact unit names the pool that was asked for.

---

## 3. Found, not fixed

### `how much is AQUA` → oracle error (R-04, and R-06's AQUA failure)
Answer: *"The price for AQUA is currently unavailable due to an oracle contract error."*
Facts empty. The behaviour is honest — it does not invent a price — but §0.6 of the script
says AQUA is priceable, so one of the two is wrong. Decide which: if the oracle has no AQUA
feed, §0.6 needs correcting; if it does, the feed is broken. This is MCP/oracle side, not UI.

### One deposit routed as `multi_leg` and errored
Session log holds two rows for the same prompt minutes apart:

```
deposit 5 XLM as collateral   ERROR   multi_leg                    8m
Deposit 5 XLM collateral      executed  vanna_deposit_collateral   7m
```

Same single-leg intent, two different routes, one failed. Looks reproducible and is a
routing bug rather than a UI one. Not investigated.

### 66 dependabot vulnerabilities (32 high) on the default branch
Reported by GitHub on push. Pre-existing, unrelated to these commits, but worth clearing
before handover.

---

## 4. Verified working (no action)

- **Multi-leg write, end to end.** "Park 20 XLM then farm 10 BLUSDC at 2x" → plan card
  showed *"2 steps · 4 signatures (a levered step signs more than once) · earn → farm"* with
  a 5-minute quote countdown, then ran to **4 of 4 settled**, "Nothing is left in flight".
  Each leg carried **its own** tx hash — that is P-05 in the script, passing:

  | # | venue | op | amount | hash |
  |---|---|---|---|---|
  | 1 | EARN | lend | 20 XLM | `00082288c6…048707` |
  | 2 | MARGIN | deposit collateral | 10 BLUSDC | `c5b516d9c8…e9faf9` |
  | 3 | MARGIN | borrow | 10 BLUSDC | `05732813f4…6946c4` |
  | 4 | FARM | supply to blend | 9.965 BLUSDC | `e6a19a5ce0…115a24` |

- **Session log reached a terminal state** — the owner's long-standing "stuck on staged"
  complaint did NOT reproduce. Stored row: `status: "executed"`, `tone: "ok"`,
  `strategy: true`, all four legs `done`, merged into one parent row rather than flooding
  the log. Consistent with the earlier note that 13 signed writes all closed correctly;
  treat that bug as unreproduced, and re-confirm from the owner before spending time on it.

- **Reads:** `Can I borrow 20 USDC?`, `what's my health factor`, `show me the protocol
  contract addresses` (15/15 in one scrolling register, nothing truncated), `price of XLM`.

- **Write gate with auto-sign OFF:** staged, XDR built, `Approve & sign` / `Modify` /
  `Cancel`, session-log row `STAGED` in the active tone.

- **Sequence handling:** a re-submitted write surfaced *"sequence outdated — rebuilding a
  fresh transaction"* and recovered rather than failing.

---

## 5. Corrections to `note.txt`

- **§18 says "expect 778 passing" — it is now 790.** 12 tests were added in
  `tests/lib/answer-identifier-facts.test.ts` covering the answer-card enumeration fix.
  `npx tsc --noEmit` clean.
- **§0.1's warning is now confirmed in practice**, not just theory: with auto-sign ON,
  single-leg writes settled with no gate while a multi-leg plan was still gated by the plan
  card. Both halves of that sentence are true as written.

---

## 6. Not covered

Sections 6 (account lifecycle), 9 (risk gate — needs the thin W3 wallet), 10 (plan
integrity: expiry, double-approve, mid-execution refresh), 12 (prompt injection), 16
(resilience) and 17 (observability) were not run. Sections 12 and 10 are the two that gate
production sign-off and neither has been touched.

Wallet states W0/W1/W3 from §0.4 were never prepared — everything above ran on a single
funded W2 account, so every `[W1]` / `[W3]` / `[W0]` row in the script is still open.
