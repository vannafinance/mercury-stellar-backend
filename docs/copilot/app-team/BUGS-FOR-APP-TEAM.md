# Two bugs in shared app code — found by the copilot, not fixed by it

Found while building the copilot, which reads these files. **We reverted our changes; the
code below is exactly what is on `dev` today.** Reporting rather than fixing — these are
your files.

A patch with the fixes we had written is at `shared-file-changes.patch` in this folder if
useful. Ignore it if you would rather fix it your own way.

---

## 1. A failed debt read is silently dropped and still reports success  ⚠️ *safety*

**`lib/margin-utils.ts:2188`** — `getCurrentBorrowedBalances`

```js
rows.forEach((row, index) => {
  if (row.status === 'fulfilled' && row.value) {
    borrowedBalances[row.value.token] = row.value.balance;
  } else if (row.status === 'rejected') {
    console.warn(`⚠️ Failed to get balance for token ${borrowedTokens[index]}:`, row.reason);
  }
});

return { success: true, data: this.addUsdcAliases(borrowedBalances) };   // ← always true
```

Each token's debt is read concurrently via `Promise.allSettled`. A rejected leg is logged
to the console and dropped, and the function returns `success: true` regardless. The caller
cannot tell "this account has one debt" from "this account has two debts and one read
failed".

**Why it matters:** a dropped leg *lowers* total debt, which *raises* the displayed health
factor. The user is shown a position safer than it is.

**It is not theoretical.** `soroban-testnet.stellar.org` returns `read ECONNRESET` on
`simulateTransaction` regularly — visible many times in a single dev session. That is
exactly the rejection this swallows.

**Measured**, account `CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C`:

| Source | Debt |
|---|---|
| RiskEngine `get_current_total_borrows` | **$2,705.60** |
| RiskEngine `liquidation_snapshot` | **$2,705.60** (agrees) |
| App `computeMarginSnapshot` | **$1,684.99** — the XLM leg only; USDC gone |

Two independent contract functions agree; only the app differs.

**Suggested shape:** if any leg rejects, return `success: false` (or a partial flag the
caller must handle). An incomplete debt total should not be presentable as a complete one.

---

## 2. `/api/mercury/events` returns 500 when Mercury is simply not configured

**`app/api/mercury/events/route.ts:37`**

```js
if (!REST_BASE || !MERCURY_KEY) {
  return NextResponse.json(
    { error: "Mercury is not configured (MERCURY_URL / MERCURY_KEY missing)." },
    { status: 500 },
  );
}
```

Any environment without `MERCURY_URL` / `MERCURY_KEY` gets a **500 on every page load**,
in ~110 ms with no upstream call. A missing optional indexer reads as a crashed route, and
it buries real 500s in the noise.

**Suggested shape:** `200` with an empty list and a header or field saying the feature is
unconfigured, so the client can degrade instead of erroring. Low priority — cosmetic
compared with #1.

---

## Not a bug, for the record

The USDC/BLUSDC dedup in `lib/account-snapshot.ts` looked wrong at first glance — it keeps
the larger amount rather than summing. On the accounts we checked, `USDC` and `BLUSDC` carry
the **same** value (the same debt reported twice), so the fold is correct. We nearly
reported it and it would have been a false alarm.

---

## Separately — a definition question, not a bug

`get_current_total_balance_internal` on the RiskEngine
(`Protocol_V1_Soroban` branch `testnet` @ `1d333fb`) walks only
`smart_account_contract_client.get_all_collateral_tokens()` — **posted** collateral.
`computeMarginSnapshot` additionally counts raw SAC balances held in the same margin
account but never posted.

Ledger-pinned on `CBOQAN…G5XY` at 4603116:

| | Collateral | Debt | Health factor |
|---|---|---|---|
| App | $1,087.20 | $278.91 | **3.90** |
| Contract | $953.80 | $278.91 | **3.42** |

Debt agrees exactly, so this is not timing. The difference is **unposted raw SAC** held in
the same margin account.

**No action requested. Your number is not wrong** — `posted + farm + unposted ÷ debt` is a
reasonable solvency measure, and the Margin page figure is what the copilot treats as the
reference for display.

This is recorded only so the two surfaces are known to differ **by definition**: the
RiskEngine's liquidation check compares against **posted collateral only**, so anything the
copilot derives from the contract (sizing, "will this breach your floor") will be computed on
the smaller base. That is deliberate on our side, not a disagreement with you.

The one thing worth knowing: on an account carrying a large unposted balance the two figures
diverge further than the $133 seen here. If you ever want the split surfaced —
posted / unposted / posted-health — we have the contract read for it and can hand it over.

---

## 3. `computeMarginSnapshot` has no timeout and `/api/account` shares one inflight  ⚠️ *hang*

**`lib/account-snapshot.ts:140`** — `computeMarginSnapshot` / `snapshotInflight`

The snapshot joins one process-wide promise per C-address. Nothing bounds it. Copilot
`computeAccountPosition` awaits that same promise (we timeout our *wait*; we cannot abort
the work). Measured on 11 Sep 2026 against `soroban-testnet.stellar.org` `ECONNRESET`:

| Call | Duration |
|---|---|
| `GET /api/account/[addr]` | **6.3s–96s** (concurrent stamps) |
| `GET /api/analytics/accounts` | **~238–259s** |

A signed-in `"what's my health factor?"` on `/copilot` then waited until the **browser**
120s abort — UI copy `"The investigation timed out. Please try again."` — because the
copilot used to fall through to Vertex after a missed seed, and MCP's own fetch timeout
is 90s.

**Suggested shape:** a hard deadline on `computeMarginSnapshotUncached` (8–15s is enough;
the copilot already budgets 8s for the seed). Timed-out inflight should reject so the
next caller does not join a 90s corpse. Copilot will not edit this file.
