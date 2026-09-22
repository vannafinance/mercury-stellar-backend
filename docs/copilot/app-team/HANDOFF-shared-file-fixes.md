# Handoff — three shared-library fixes (Gemini)

**For:** Gemini 3 Flash (Antigravity). **Author:** Claude, acting as auditor.
**Created:** 11 Sep 2026.
**Repo:** `C:\Users\akgam\Documents\vanna-copilot-orchestrator`
**Baseline:** `tsc` clean · `npx vitest run` = **1,631 passed / 0 failed / 3 skipped**.

---

## 0. Scope — this is a file allowlist, not a repo

**A second agent (Grok, in Cursor) is working this same repository right now.** The only
thing keeping you apart is that Grok is *explicitly forbidden* from the three files below.
That is what makes this safe.

**You may edit exactly these:**

```
lib/account-snapshot.ts
lib/margin-utils.ts
app/api/mercury/route.ts
app/api/mercury/events/route.ts
```

plus tests you add for them.

**Everything else is Grok's.** Not `lib/copilot/**`, not `components/**`, not
`hooks/**`, not any other route. If a fix seems to require a file outside the list,
**stop and say so in your report** — do not reach for it. A collision here costs more than
the fix is worth.

**Do not commit, do not push, do not open a PR, do not deploy.**

Report once at the end:

```
**Done** / **Verified** / **Not done or blocked** / **Deviations** / **New findings**
**Suite:** tsc · vitest
```

If a claim in this document is wrong, say which and what the truth was.

---

## 1. Why you are being asked to touch someone else's files

These are the app developer's files. We deliberately reported rather than fixed them —
`docs/copilot/app-team/BUGS-FOR-APP-TEAM.md` is already written and stands.

The owner has now decided to fix them **locally so the copilot is unblocked**, while the app
team keeps ownership of the real change. So:

- Fix them on this branch, confined to the allowlist.
- **Then export a clean patch** (`git diff -- <the four files> > docs/copilot/app-team/shared-file-fixes.patch`)
  so the app team can review and take it, or write their own.
- Keep the fixes **minimal and obvious**. This is not a refactor. Someone else has to read
  the diff and agree with it quickly.

---

## 2 · The unbounded snapshot — the important one

**`lib/account-snapshot.ts`** — `computeMarginSnapshot` / `snapshotInflight`

This single defect has now caused **five distinct failures** in the copilot: a 120-second
health-factor abort, `/api/account` measured at **6.3s–96s**, a hung Approve button, a
blocked risk validation, and a wedged dev server.

Two problems, both in the same place:

1. **No deadline.** Nothing bounds the work. Callers can bound their *wait* with
   `AbortSignal`, but the underlying RPC scan keeps running.
2. **A poisoned shared promise.** The snapshot joins one process-wide inflight promise per
   C-address. When a scan stalls at 90 seconds, every later caller **joins that same stalled
   promise** rather than starting a fresh one. One bad read poisons everything behind it.

**The trigger is not fixable and you should not try:** `soroban-testnet.stellar.org` returns
`read ECONNRESET` on `simulateTransaction` constantly — a hundred times in a single dev
session. That is their RPC. **What is ours is that one dropped socket takes down a read four
other things are waiting on.**

**Required shape:**

- A hard deadline on `computeMarginSnapshotUncached` — **8–15s** is enough; the copilot
  already budgets 8s for its own seed.
- **A timed-out inflight promise must reject and be cleared**, so the next caller starts a
  fresh read instead of joining a corpse.
- On timeout, return an explicit *unavailable* result, **never a partial one presented as
  complete.** A half-read position that looks whole is how "health factor 0.01" reached a
  user on a healthy account.

---

## 3 · A failed debt read reports success  ⚠️ *safety*

**`lib/margin-utils.ts`** — `getCurrentBorrowedBalances` (~line 2188)

```js
rows.forEach((row, index) => {
  if (row.status === 'fulfilled' && row.value) { … }
  else if (row.status === 'rejected') {
    console.warn(`⚠️ Failed to get balance for token ${borrowedTokens[index]}:`, row.reason);
  }
});
return { success: true, data: this.addUsdcAliases(borrowedBalances) };   // ← always true
```

Each token's debt is read concurrently through `Promise.allSettled`. A rejected leg is
logged and dropped, and the function reports `success: true` regardless. The caller cannot
distinguish "this account has one debt" from "this account has two and one read failed".

**Why it is a safety bug, not a cosmetic one:** a dropped leg *lowers* total debt, which
*raises* the displayed health factor. The user is shown a position **safer than it is**.

Measured on `CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C`:

| Source | Debt |
|---|---|
| RiskEngine `get_current_total_borrows` | **$2,705.60** |
| RiskEngine `liquidation_snapshot` | **$2,705.60** (independent, agrees) |
| App `computeMarginSnapshot` | **$1,684.99** — the XLM leg only |

**Required shape:** if any leg rejects, return `success: false`, or a partial flag the caller
is forced to handle. An incomplete debt total must not be presentable as a complete one.

**Do not "fix" the USDC/BLUSDC dedup while you are in there.** It keeps the larger value
rather than summing, which looks wrong — but on real accounts both carry the same debt
reported twice, so the fold is correct. We nearly reported it and it would have been a false
alarm.

---

## 4 · Mercury 500 when simply unconfigured

**`app/api/mercury/events/route.ts:37`** (and the sibling route)

```js
if (!REST_BASE || !MERCURY_KEY) {
  return NextResponse.json({ error: "Mercury is not configured…" }, { status: 500 });
}
```

Any environment without `MERCURY_URL` / `MERCURY_KEY` gets a **500 on every page load**, in
~110ms with no upstream call. A missing optional indexer reads as a crashed route, and it
buries real 500s in the noise.

**Required shape:** `200` with an empty list plus a field or header saying the feature is
unconfigured, so the client degrades instead of erroring. Lowest priority of the three.

---

## 5 · Verification

Unit tests alone will not prove this. Specifically check:

1. **The deadline fires.** A stalled read returns *unavailable* within the budget rather than
   hanging.
2. **The inflight promise clears.** Two callers, the first timing out — the second must start
   a **fresh** read, not inherit the failure. This is the part most likely to be got wrong.
3. **A rejected debt leg surfaces.** Mock one rejection; the result must not be
   `success: true`.
4. **Live:** with the dev server running, `GET /api/account/CBOQAN5NFII4P5HD73M2IRSFYZSXC5XC76FQWQ5JU7LJAO66TFFPG5XY`
   should return inside the deadline even while `ECONNRESET` is firing. Report the actual
   duration, not "it works".

Suite must stay ≥ **1,631 / 0 / 3**. If a copilot test fails because it depended on the old
unbounded behaviour, **say so and stop** — that is Grok's file to change, not yours.

---

## 6 · Deliverable

1. The four files fixed, minimally.
2. `docs/copilot/app-team/shared-file-fixes.patch` — the diff, for the app team.
3. A short note appended to `BUGS-FOR-APP-TEAM.md` saying a local fix now exists, so nobody
   thinks the report is stale.
