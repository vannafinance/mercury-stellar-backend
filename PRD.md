# Vanna Protocol — Product Requirements Document (for automated testing)

> Purpose: this PRD is written to drive automated test generation (frontend E2E + API).
> It describes intended behavior, user flows, API contracts, acceptance criteria, the
> test environment, and **known limitations that must NOT be reported as bugs**.

---

## 1. Product Overview

**Vanna** is a DeFi protocol web app on the **Stellar / Soroban** network (currently **Testnet**).
It lets users:
- **Earn** — supply assets to lending pools and earn yield (receive vTokens).
- **Margin** — open a margin (smart) account, deposit collateral, borrow against it, repay, and transfer collateral.
- **Farm** — deploy capital into yield strategies (Blend single-asset lending, Soroswap & Aquarius LP), including a **one-click leveraged-yield** flow.
- **Analytics** — protocol-wide risk dashboards, positions, liquidations, and stress simulations.

The app has two modes, toggled in the navbar:
- **Pro** — full feature set.
- **Lite** — simplified, one-click leveraged-yield experience.

**Tech stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS, Zustand (state), React Query (data), Freighter wallet (Stellar). Backend = Next.js API routes (Node runtime) backed by Soroban RPC + the Mercury indexer.

---

## 2. Test Environment & Preconditions

- **Network:** Stellar **Testnet** (Soroban RPC `https://soroban-testnet.stellar.org`).
- **Wallet:** **Freighter** browser extension, set to Testnet. Wallet connection is required for all account-specific features.
- **Funding:** the app has a **Faucet** button (navbar) to obtain testnet XLM/tokens.
- **Two test states:**
  1. **Disconnected** — no wallet connected (public/read-only views).
  2. **Connected** — Freighter connected with a funded testnet account; some accounts have an existing margin/smart account and positions, some do not.
- **Base URL:** the app runs at the deployment root (e.g. `http://localhost:3000` in dev, or the Vercel preview URL).

> NOTE for E2E: flows that **sign transactions** (deposit/borrow/repay/withdraw/one-click) require Freighter signing and a funded account. If wallet automation is unavailable, test up to the "confirm/sign" step and assert the pre-sign UI state (validation, button labels, modals).

---

## 3. Roles / Personas

| Persona | Description |
|---|---|
| **Visitor** | No wallet connected. Can browse public data (pools, analytics) and is prompted to connect. |
| **LP / Earner** | Connected wallet supplying to lending pools (Earn). |
| **Margin trader** | Connected wallet with a margin (smart) account; deposits collateral, borrows, repays. |
| **Farmer (Lite)** | Connected wallet using the one-click leveraged-yield flow. |

---

## 4. Navigation & Routes

Primary navbar: **Earn · Margin · Trade · Farm · Analytics**, plus **Faucet** and **wallet connect** controls, and a **Pro/Lite** toggle.

| Route | Page | Notes |
|---|---|---|
| `/` | Home dashboard | Pro: margin dashboard. Lite: simplified one-click home. |
| `/margin` | Margin account | Stat cards + leverage/repay/transfer + positions table. |
| `/earn` | Earn (lending) | Overall Deposit / Net Earnings charts; Vaults & Positions tabs. |
| `/earn/[id]` | Earn pool detail | Per-pool stats + supply/withdraw + history. |
| `/farm` | Farm | Vaults & Positions tabs; Lending/Single + LP/Multiple sub-tabs. |
| `/farm/[id]` | Farm pool detail | Add/Remove liquidity + analytics + transactions. |
| `/trade/spot`, `/trade/perps`, `/trade/options` | Trade | Trading UIs. |
| `/portfolio` | Portfolio | Aggregated balances/positions. |
| `/analytics` and sub-routes | Analytics | Overview, positions, liquidations, oracles, whales, alerts, risk-explorer (multiple scenarios), stress-test. |
| `/stats` | Protocol stats | Gated; **pubnet-only data** (empty on testnet — expected). |

### 4.1 Pro/Lite mode behavior (testable)
- Toggling **Lite** hides **Trade**, **Farm**, and **Earn** from the navbar and, if the user is on one of those routes, **redirects to `/`**.
- **Analytics** is also blocked in Lite (redirects to `/`).
- Toggling back to **Pro** restores all nav items.
- The selected mode **persists** across reloads.

---

## 5. Functional Requirements

### 5.1 Wallet & Faucet
- **FR-W1:** A disconnected user sees a **Connect Wallet** affordance; account-specific sections prompt to connect.
- **FR-W2:** Connecting via Freighter shows the connected address (truncated, e.g. `GC6VYQ…AGRP`) and a network indicator ("Connected", "Testnet").
- **FR-W3:** The **Faucet** button opens a faucet flow to obtain testnet funds.
- **FR-W4:** Disconnecting clears account-specific UI back to the disconnected state.

### 5.2 Earn (lending pools)
- **FR-E1:** The **Vaults** tab lists pools (XLM, USDC/BLUSDC, AqUSDC, SoUSDC) with **Assets Supplied, Supply APY, Assets Borrowed, Borrow APY, Utilization Rate**, and an "Active" status.
- **FR-E2:** The **Positions** tab lists the connected user's supplied positions; updates **instantly** after a supply/withdraw.
- **FR-E3:** **Overall Deposit** headline shows the user's total deposited USD and **updates instantly** on deposit/withdraw (must NOT lag behind the success toast). The chart curve below it may update on a slower cadence (smoothed) — that is intended.
- **FR-E4:** **Supply** flow: select pool → enter amount → confirm → on success a toast appears and the position + Overall Deposit reflect the change.
- **FR-E5:** **Withdraw** flow: cannot withdraw more than the deposited balance; shows a clear validation message otherwise.
- **FR-E6:** Pool/position data refreshes on each ledger tick **without** flipping the UI into a full-screen/spinner loading state (stale-while-revalidate).

### 5.3 Margin account
- **FR-M1:** A connected user **without** a margin account sees a **Create Margin Account** action.
- **FR-M2:** The top **stat cards** show **Net Health Factor, Collateral Left Before Liquidation, Net Available Collateral, Net Amount Borrowed**.
- **FR-M3:** On reload, stat cards and the **Margin Account Info** sidebar show **real values instantly** (from a cached per-account snapshot) — they must **never** show a raw `0`/`$0.00` flash or a spinner glyph; while data is pending they show **shimmer placeholders** (Aave-style gray bars).
- **FR-M4:** The **Positions** table lists current positions (Collateral Deposited, Borrowed Assets, Leverage, Interest, Repay action). Values must be **stable** (no flicker between two values across ledger ticks).
- **FR-M5:** **Deposit collateral** works for a 1× position.
- **FR-M6:** **Borrow / leverage > 1** is currently disabled (see Known Limitations) — attempting it surfaces a clear error and does not crash.
- **FR-M7:** **Repay** and **Transfer Collateral** tabs are available and validate inputs.

### 5.4 Farm (yield strategies)
- **FR-F1:** The **Vaults** tab lists farm pools: Blend single-asset (XLM, USDC) and LP pools (Aquarius XLM/USDC, Soroswap XLM/USDC) with APY/stats.
- **FR-F2:** The **Positions** table shows the user's farm positions with columns **Asset · Protocol · Holdings · APY**; the breakdown (b-tokens / LP composition) appears as a wrapping subtext and must **not overlap** the APY column.
- **FR-F3:** **One-click "Deposit & Deploy"** (Lite): select pool → enter deposit amount → choose leverage. At **1× (no borrow)** the deposit deploys into the pool successfully (deposit + supply, two signatures).
- **FR-F4:** Leverage **> 1** is currently disabled (Known Limitations) — surfaces a clear error, no crash.
- **FR-F5:** The deposit amount field has a **MAX** button. For **XLM**, MAX must reserve the account's minimum balance + a fee buffer, so the resulting transfer does not fail; entering an amount that would breach the reserve shows **"Keep XLM for fees & reserve"** rather than failing on-chain.
- **FR-F6:** **Position History** tab lists past supply/withdraw events for the account.

### 5.5 Analytics
- **FR-A1:** Analytics pages render protocol dashboards (TVL, volume, positions, liquidations, oracles, whales, alerts).
- **FR-A2:** Risk-explorer scenario pages render and accept inputs without crashing.
- **FR-A3:** Analytics is **Pro-only** (blocked/redirected in Lite mode).

### 5.6 Cross-cutting UX
- **FR-X1:** Loading states use **shimmer/skeleton** placeholders, never raw `0`/`$0.00` or spinner glyphs for account stats.
- **FR-X2:** Reloading any account page restores values **instantly** from cache, then revalidates in the background.
- **FR-X3:** Errors render a dismissible banner/modal with a human-readable message (never a raw stack trace).
- **FR-X4:** Layout is responsive: desktop tables collapse to a mobile accordion below the `xl` breakpoint.
- **FR-X5:** Theme (dark/light) toggle works and persists.

---

## 6. Backend / API Contracts

All API routes are Next.js App Router handlers (`app/api/.../route.ts`). Test these directly (status, JSON shape, headers).

| Method | Path | Description | Success | Notes |
|---|---|---|---|---|
| GET | `/api/pools` | All 4 lending-pool stats | `200` JSON keyed `XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC`; each has `totalSupply, totalBorrowed, availableLiquidity, utilizationRate, vTokenSupply, supplyAPY, borrowAPY, exchangeRate` (all strings) | `Cache-Control: public, s-maxage=30, stale-while-revalidate=120`. On failure → `502` `{error,detail}` + `no-store`. |
| GET | `/api/account/[addr]` | Per-account margin snapshot for a wallet `addr` | `200` JSON with `hasMarginAccount`, `marginAccountAddress?`, `borrowedBalances`, `collateralBalances`, `totalBorrowedValue`, `totalCollateralValue`, `grossCollateralValue`, `totalValue`, `avgHealthFactor`, `collateralLeftBeforeLiquidation`, `netAvailableCollateral`, `borrowRate`, `debtLimit` | Edge-cached (`s-maxage≈15`). `hasMarginAccount=false` when the wallet has no account. |
| GET/POST | `/api/mercury` , `/api/mercury/events` | Mercury indexer proxy (event history) | `200` JSON | Server-side proxy; holds the indexer credential. |
| GET | `/api/analytics/tvl` `/volume` `/liquidations` `/top-borrowers` | Analytics aggregates | `200` JSON | Used by Analytics dashboards. |

### API acceptance criteria (testable)
- **AC-API1:** `GET /api/pools` returns `200` with all four pool keys and the numeric-string fields above; APYs/utilization parse as numbers; `exchangeRate >= 1`.
- **AC-API2:** `GET /api/pools` sends the documented `Cache-Control` header.
- **AC-API3:** `GET /api/account/<valid G-address>` returns `200` with the snapshot shape; `avgHealthFactor` is a number (or the ∞ sentinel `999` when no debt); `debtLimit = grossCollateralValue / 1.1`.
- **AC-API4:** `GET /api/account/<invalid address>` does not 500 with a raw stack trace (returns a handled response).
- **AC-API5:** Analytics endpoints return `200` JSON and never leak server stack traces on error.

---

## 7. Key User Flows (E2E happy paths)

**Flow 1 — Connect & browse (Visitor → Connected):**
1. Open `/`. 2. Click Connect Wallet → Freighter → approve. 3. Address + "Connected/Testnet" shown. 4. Navigate to `/earn`, `/margin`, `/farm` — each renders without errors.

**Flow 2 — Earn supply:**
1. Connected on `/earn`. 2. Vaults tab lists pools with APY/utilization. 3. Open a pool, enter a deposit amount, confirm/sign. 4. Success toast appears. 5. **Overall Deposit headline and Positions tab update immediately.**

**Flow 3 — Margin reload (no-flicker):**
1. Connected with an existing margin account on `/margin`. 2. Hard-reload. 3. Stat cards + sidebar show **shimmer → real values instantly**, never `0`/`$0.00`/spinner. 4. Positions table value is stable across several seconds (no flip).

**Flow 4 — Farm one-click 1× deposit:**
1. Lite mode, `/` (one-click home) or `/farm`. 2. Select XLM Blend pool. 3. Click **MAX** → amount leaves XLM reserve intact. 4. Leverage 1× → button reads **"Deposit Margin"** → confirm/sign (×2). 5. Success toast; Farm Positions reflect the deposit.

**Flow 5 — Lite mode redirects:**
1. Pro mode, navigate to `/earn`. 2. Toggle **Lite**. 3. App **redirects to `/`** and Earn/Trade/Farm disappear from the nav. 4. Toggle **Pro** → nav restored.

---

## 8. Non-Functional Requirements
- **NFR-1 (Perf/UX):** Account pages paint cached values within ~1 frame on reload; background revalidation must not blank the UI.
- **NFR-2 (Resilience):** RPC/indexer failures degrade gracefully (cached/fallback values, error banner), never a white screen.
- **NFR-3 (Security):** Indexer credentials live only in server routes (`/api/mercury*`), never in client bundles. No private keys handled by the app (signing is delegated to Freighter).
- **NFR-4 (Responsive):** All tables/cards usable on mobile widths.
- **NFR-5 (No console errors):** Primary flows produce no uncaught console errors.

---

## 9. KNOWN LIMITATIONS — do NOT report these as bugs

1. **Borrow / leverage > 1 is temporarily disabled** (pending an on-chain `lend_to` contract fix). Any deposit+borrow or leverage>1 one-click/margin action is expected to surface an error and is **out of scope**. Only **1× deposit-only** flows succeed.
2. **Earn "Supply APY" is a placeholder** formula (`2.0 + utilization × 10`), not chain-derived — so the **same XLM pool shows a different Supply APY on Earn (~6–7%) vs the Farm pool page (real Blend rate, can be triple-digit at high utilization)**. This mismatch is **known/expected**, not a bug.
3. **Net Earnings shows `$0.00`** — per-wallet earnings history is intentionally disabled pending a data migration.
4. **`/stats` (Hubble analytics) has no testnet data** — it is pubnet-only; an empty/placeholder view on testnet is expected.
5. **Testnet pool APYs/utilization can look extreme** (e.g. 200–500%) due to distorted testnet pool state + daily compounding — mathematically correct, not a bug.
6. **Two signatures** for the one-click 1× deposit (deposit, then deploy) are expected.

---

## 10. Out of Scope for this test pass
- Full on-chain math correctness of APY / health-factor / reserve formulas — covered by the project's deterministic unit-test suite (`tests/`), not E2E.
- Real liquidation execution and oracle-failure simulations beyond UI rendering.
- Multi-wallet / hardware-wallet signing.

---

## 11. Priority for test generation
1. **P0:** Wallet connect/disconnect; navigation across all primary routes (no crashes/console errors); Pro/Lite toggle + redirects; `/api/pools` & `/api/account/[addr]` contracts.
2. **P1:** Earn supply happy path + instant Overall Deposit/positions update; Margin reload no-flicker/no-`0`/shimmer; Farm one-click 1× deposit + MAX reserve handling; Farm Positions table layout (no column overlap).
3. **P2:** Withdraw/repay/transfer validation; analytics pages render; responsive/mobile; theme toggle; error-state rendering.
