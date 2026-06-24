# Vanna (Stellar / Soroban) — End-to-End Test Strategy & QA Plan

**Functional and Non-Functional Testing** · Pro mode (margin, earn, farm, trade, analytics) · Testnet & Pubnet
Version 1.0 · Owner: QA / Engineering

This plan defines the complete testing approach end to end: every user-facing module, the three-layer
data backend (Soroban RPC, Mercury event history, Hubble aggregates), the edge-cache read path, and the
financial correctness a lending/margin protocol must guarantee. It is organised the industry way —
**functional** (does it do the right thing) and **non-functional** (does it do it well) — and mapped onto
this product's concrete features.

---

## 1. Application Overview & Test Basis

Decentralized margin/lending app on Stellar using Soroban contracts, a Freighter-connected wallet, and a
Next.js 16 / React 19 frontend (React Query + Zustand).

### 1.1 Functional modules under test

| Module | Key flows | Risk |
|---|---|---|
| Wallet & Session | Freighter connect/disconnect, network (testnet/pubnet), address resolution, Pro/Lite | High |
| Margin — Leverage your Assets | Deposit (WB/MB), single & dual borrow (leverage auto-calc), leverage 1–10X, validation | Critical |
| Margin — Repay Loan | Repay full / partial / dust debt, asset selection, allowance | Critical |
| Margin — Transfer Collateral | Move collateral in/out of the margin account | High |
| Margin — Liquidate Account | Liquidation eligibility, premium/fee, health-factor gating | Critical |
| Margin — Positions & Health | Positions table, attribution, health factor, net available, debt limit | Critical |
| Earn | Pools (XLM, BLUSDC, AQUSDC, SOUSDC), deposit, withdraw, supply/borrow APY, exchange rate | Critical |
| Farm | Blend / Aquarius / Soroswap LP positions, deposit, claim, APY | High |
| Trade | Spot, Perps, Options surfaces | Medium |
| Portfolio | Aggregated trader view | Medium |
| Analytics | Overview, oracles, positions, liquidations, whales, alerts, risk-explorer, stress-test | High |
| Stats | Hubble protocol-wide aggregates (pubnet only) | Medium |

### 1.2 Data architecture (reflected in every data-correctness test)

- **RPC layer** — Soroban public RPC; authoritative **current** state (balances, health factor, pool stats). Cannot be replaced by an indexer for live numbers.
- **Mercury** — per-account **event history** (deposits/borrows/repays with tx hashes). Drives position attribution and Positions History. **Cannot** serve current balances/HF.
- **Hubble (BigQuery)** — protocol-wide aggregates, **pubnet-only**. Powers `/stats`; gated off on testnet.
- **Edge cache** — read routes carry `Cache-Control: s-maxage` (15s account, 30s pools & analytics) + `stale-while-revalidate`; `?force=1` bypasses. Collapses per-visitor RPC fan-out.
- **Optimistic UI** — confirmed deposits paint immediately, then reconcile; a degraded client read must never blank known collateral.

### 1.3 Test environments

| Environment | Network | Purpose |
|---|---|---|
| Local / Dev | Testnet | Developer smoke + feature testing; Freighter on testnet, faucet assets |
| Staging (Vercel preview) | Testnet | Integration, E2E, UAT; verify edge cache via `x-vercel-cache` |
| Production | Pubnet | Smoke, monitoring, Hubble `/stats`, real-funds caution |

### 1.4 Tooling

- **Unit / integration** — Vitest + @testing-library/react + happy-dom (161 tests in repo).
- **E2E / UI** — scripted browser journeys (Playwright recommended to formalise).
- **Manual / exploratory** — Freighter on testnet for wallet-signed flows.
- **Static** — `tsc --noEmit`, ESLint, `next build`; dependency scanning via Dependabot.

---

## 2. Test Strategy & Approach

### 2.1 Test pyramid
- **Unit (base)** — pure financial math/reducers: APY, exchange rate, health factor, leverage, attribution, fixed-point (WAD 1e18 / SCALAR_7 1e7). Fast, deterministic, no chain.
- **Integration (middle)** — API route handlers (cache headers, error contracts), store ↔ snapshot reconciliation, hook ↔ React Query with mocked RPC/Mercury.
- **E2E (top)** — wallet-signed journeys on testnet: connect → deposit → borrow → repay → liquidate, plus read-only analytics.

### 2.2 Entry & exit criteria

| Gate | Entry | Exit |
|---|---|---|
| Feature test | Build green; tsc + ESLint clean; flag on | All P1/P2 pass; no open Critical/High |
| Regression | Feature tests passed; release branch cut | Full suite green incl. 161+ unit; no new regressions |
| UAT | Regression passed on staging | Product sign-off; known issues triaged |
| Production smoke | UAT signed off; deploy succeeded | Smoke journeys pass on pubnet; cache + RPC healthy |

### 2.3 Defect severity (DeFi-weighted)

| Severity | Definition | Example |
|---|---|---|
| S1 Critical | Loss/lock of funds, wrong financial math, false liquidation, broken sign | HF ∞ with real debt; repay of wrong amount |
| S2 High | Core flow blocked, no workaround, misleading balance/health | MB collateral grid blank though account holds collateral |
| S3 Medium | Works with workaround; confusing data | Borrow attaches to wrong position row until refresh |
| S4 Low | Cosmetic, copy, minor layout | Class-name lint, spacing on a breakpoint |

---

## 3. Functional Testing (does the system work correctly?)

Each module is covered across feature, integration, API, regression, and E2E types, with UAT scenarios called out.

### 3.1 Wallet & Session
- Connect Freighter; reject when absent/locked with a clear prompt.
- Correct network detection (testnet vs pubnet); block on mismatch.
- Address resolution: G-address → margin (C-)account discovery; cache-then-reconcile correct.
- Disconnect clears all per-account state (no balance/HF bleed); reconnect refetches.
- Pro ↔ Lite routes and guards correctly.

| ID | Scenario | Expected | Pri |
|---|---|---|---|
| WAL-01 | Connect on testnet | Address shown; margin account resolved; balances load | P1 |
| WAL-02 | Extension locked | Friendly "unlock wallet"; no crash | P2 |
| WAL-03 | Wrong network | Action blocked with network-mismatch guidance | P1 |
| WAL-04 | Wallet switch A→B | B's data only; A's collateral/HF never shown | P1 |

### 3.2 Margin — Leverage your Assets (Deposit + Borrow)

**Deposit**
- WB: amount ≤ spendable wallet balance; XLM keeps min reserve + fee buffer (cannot deposit 100% of XLM).
- MB: grid lists every real collateral the account holds; multi-select; WB↔MB fills instantly (no "no collateral" flash while loading).
- Add/edit/remove multiple collateral rows; save gates the borrow calc.
- Optimistic paint: a confirmed deposit shows immediately, then reconciles; a degraded read must NOT blank it.

**Borrow (single & dual, leverage-driven)**
- Slider 1–10X; borrow auto-calculates to `deposit × (leverage − 1)`.
- Single: full amount on the selected asset; **Max Value snaps leverage to 10X**.
- Dual: total auto-splits 50/50 across two distinct assets; Max Value hidden.
- Real Stellar assets only (XLM, BLUSDC, AqUSDC, SoUSDC) — no placeholder/EVM tokens.
- Manual override pauses auto-fill for that card until a driving input changes.

| ID | Scenario | Expected | Pri |
|---|---|---|---|
| BOR-01 | Single, save deposit at 3X | Borrow auto-fills to deposit×2; Total = Max; no red | P1 |
| BOR-02 | Dual, save deposit | Both cards ~50/50; Total = Max; neither card at 0 | P1 |
| BOR-03 | Manual amount > Max | Total + card red; "exceeds your limit"; submit disabled | P1 |
| BOR-04 | Dual, same asset both cards | Red "pick two different assets"; submit disabled | P1 |
| BOR-05 | Borrow with no collateral saved | Red "add collateral before borrowing"; submit disabled | P1 |
| BOR-06 | Leverage = 1X | Deposit-only; no borrow leg; button "Deposit" | P2 |
| BOR-07 | Max Value (single) | Leverage → 10X; amount = deposit×9; HF at safe edge (~1.11) | P2 |

**Integration / risk-engine pre-validation**
- Pre-submit check mirrors on-chain Risk Engine: `(grossAssets + borrow)/(debt + borrow) ≥ 1.1`; over-leverage blocked with max-safe-leverage hint.
- Existing debt reduces safe additional borrow; verify hint maths vs contract.
- Atomic single-collateral path (`deposit_and_borrow`) vs split 2-tx fallback on Soroban budget overflow — both reconcile to the same end state.

> **UAT:** a new user funds via faucet, deposits 5,000 XLM, sets 3X, borrows, sees one coherent position with the right leverage and an instantly-updated health factor.

### 3.3 Margin — Repay Loan
- Repay enabled for ANY real debt, incl. sub-cent dust.
- Full repay zeroes debt and frees collateral; partial reduces debt and improves HF.
- Repay tab pre-fills the asset from the position's Repay button.
- Token allowance/balance checks; insufficient balance blocked with guidance.
- **Amount input holds a raw string** (full 7-decimal precision; partial "." never NaN).

| ID | Scenario | Expected | Pri |
|---|---|---|---|
| REP-01 | Full repay | Debt → 0; position closes / collateral freed; HF → ∞ | P1 |
| REP-02 | Partial repay | Debt reduced; HF rises; interest handled | P1 |
| REP-03 | Dust debt | Repay button hot; residual fully clears | P2 |
| REP-04 | Type 937.3325 then edit | Full precision editable; no NaN, no 2dp truncation | P1 |

### 3.4 Margin — Transfer Collateral & Liquidate Account
- Transfer: move assets in/out; out-transfers respect the HF floor (cannot drop HF ≤ 1.1). Max/percentage presets carry full 7dp precision (floored, never above the real max).
- Liquidate: only when HF ≤ 1.1; premium and fee correct; ineligible accounts blocked.
- Post-action, positions/health refresh and stay coherent.

| ID | Scenario | Expected | Pri |
|---|---|---|---|
| LIQ-01 | Liquidate healthy account | Blocked — not eligible (HF > 1.1) | P1 |
| LIQ-02 | Liquidate unhealthy account | Allowed; premium/fee applied; settles correctly | P1 |
| TRF-01 | Transfer-out breaching HF | Blocked before it would drop HF ≤ 1.1 | P1 |

### 3.5 Margin — Positions Table & Health Factor
- Attribution: a borrow attaches to the deposit that opened it (Mercury tx-hash join); same-asset / single-collateral fallbacks; otherwise a **"Portfolio"** cross-collateral row — never mis-parented onto the largest collateral.
- Works identically for WB, MB, single & dual; re-attributes when Mercury catches up.
- HF = grossCollateral / debt; ∞ only with no debt; finite & correct when debt exists.
- Net available, collateral-left-before-liquidation, debt limit (gross / 1.1) are mutually consistent and never diverge from displayed debt.
- Positions History reads from Mercury with correct tx-hash links.

| ID | Scenario | Expected | Pri |
|---|---|---|---|
| POS-01 | Deposit XLM, borrow BLUSDC | Borrow shown on the XLM position row | P1 |
| POS-02 | HF with real debt | Finite (e.g. ~316×), never ∞, consistent with net-available | P1 |
| POS-03 | MB cross-collateral borrow | Honest "Portfolio" row; no double-counted collateral | P2 |
| POS-04 | Refresh during settle | No flip-flop; collateral never blanks mid-refresh | P1 |

### 3.6 Earn (Lending Pools)
- Four pools (XLM, BLUSDC, AQUSDC, SOUSDC). Supply/borrow APY, utilisation, vToken exchange rate match the pool-stats math.
- Deposit mints vTokens; withdraw redeems at the current exchange rate (≥ 1, rising with interest).
- Overall Deposited total updates promptly (live total, not a throttled snapshot).
- `/earn/[id]` shows position, APY, actions.

| ID | Scenario | Expected | Pri |
|---|---|---|---|
| ERN-01 | Deposit to XLM pool | vTokens credited; balance + Overall Deposited update | P1 |
| ERN-02 | Withdraw | Underlying returned at exchange rate; no rounding loss beyond dust | P1 |
| ERN-03 | APY display | Supply/borrow APY match utilisation model; exchange rate ≥ 1 | P2 |

### 3.7 Farm, Trade & Portfolio
- **Farm** — Blend/Aquarius/Soroswap LP list with correct labels/APYs; deposit/claim; `/farm/[id]`; reconcile Earn vs Farm APY discrepancy for the same underlying pool.
- **Trade** — Spot/Perps/Options render, route, guard; order-entry validation; no console errors.
- **Portfolio** — aggregated totals match per-module sources.

### 3.8 Analytics
- Protocol Overview: TVL, total borrowed, utilisation, account count from the edge-cached `/api/analytics/accounts` scan — match RPC truth.
- Oracles: per-asset price with a stale/fallback badge on RPC miss; heartbeat shown.
- Positions / Whales / Liquidations / Alerts: correct sorting, pagination, empty states.
- Risk Explorer scenarios (black-swan, cascading-liquidation, oracle-failure, stablecoin-depeg, rate-spike, whale-withdrawal, …) and Stress Test compute and render without error; shocked-vs-baseline deltas directionally correct.

| ID | Scenario | Expected | Pri |
|---|---|---|---|
| ANL-01 | Overview KPIs | TVL / borrowed / utilisation match a manual RPC cross-check | P2 |
| ANL-02 | Oracle miss | Fallback price + stale badge; no crash | P2 |
| ANL-03 | Stress test run | Completes; HF deltas sane; no NaN/∞ in UI | P2 |

### 3.9 Data Layer & API Routes (integration)
- `GET /api/account/[addr]`: full margin snapshot; `s-maxage=15, stale-while-revalidate=60`; 502 + no-store on chain failure; `?force` bypass.
- `GET /api/pools`: AllPoolStats with supplyAPY/borrowAPY/exchangeRate; `s-maxage=30`; deduped via the shared pool-stats memo.
- `GET /api/analytics/{accounts, pool-stats, oracle, events}`: `s-maxage=30` + SWR; degrade gracefully (zeros) on pool/RPC timeout.
- Mercury routes return per-account events with tx hashes; never used for current-state numbers.
- Verify the route's snapshot is the single source of truth shared with the client store (no server/client divergence).

| ID | Scenario | Expected | Pri |
|---|---|---|---|
| API-01 | Account snapshot 200 | Correct shape; HF/debt internally coherent; cache header present | P1 |
| API-02 | Chain read throws | 502 + `{error}` + `Cache-Control: no-store` | P1 |
| API-03 | Edge cache hit | Second request within TTL served from cache (`x-vercel-cache: HIT`) | P2 |
| API-04 | `force=1` | no-store; fresh chain read | P2 |

### 3.10 Cross-Cutting Functional Checks
- Theme: dark/light parity everywhere; brand gradient (`#703AE6`) and tokens consistent.
- Responsive: mobile/tablet/laptop/wide; dual-borrow cards stack then sit side-by-side; tables → mobile cards; no overflow.
- States: loading skeletons (never a 0-flash or spinner-after-data), empty states, error banners for every async surface.
- Navigation & deep links; back/forward; refresh keeps the user's own data live.
- Regression: the existing 161 Vitest cases stay green every release.

---

## 4. Non-Functional Testing (how well does it perform?)

### 4.1 Performance
- Core Web Vitals (LCP, CLS, INP) within Google "good" on home, margin, earn, analytics (console stripped in prod for LCP).
- First paint on reload uses the edge-cached snapshot — instant, no 0-flash; background revalidation never blocks.
- Bundle/route weight budgets; charts lazy where possible.
- Server route latency: cached reads return within edge TTL; cold RPC read measured and bounded.

| Metric | Target | Method |
|---|---|---|
| LCP (margin/earn) | < 2.5 s (mid laptop, throttled 4G) | Lighthouse / WebPageTest |
| INP | < 200 ms | Lighthouse field + lab |
| Cached `/api/account` | < 50 ms from edge | `x-vercel-cache: HIT` timing |
| Cold snapshot read | Bounded; shown via skeleton, no UI block | Network trace |

### 4.2 Load Testing
- Edge cache should collapse per-visitor RPC fan-out so N visitors ≈ 1 RPC scan / TTL globally (the analytics scan dropped ~1,400 RPC/scan to once per 30s).
- Validate cache hit-rate under burst (e.g. 500 concurrent users on `/api/pools`, `/api/account`, analytics) — RPC count stays roughly flat.
- Tooling: k6 / Artillery against staging; assert p95 latency and origin RPC count.

### 4.3 Stress Testing
- RPC saturation/timeout: force slow/failing RPC → graceful degradation. Pools degrade to zeros, snapshot shows skeleton, a degraded read NEVER blanks known collateral.
- Mercury lag/outage: attribution falls back safely (Portfolio row); History shows empty/retry; current-state numbers stay from RPC.
- Spike: many margin accounts in the protocol-wide scan; bounded fan-out, no unbounded memory.
- Wallet/signing: rapid repeated submits, popup dismissed mid-flow, double-click — no duplicate tx, no stuck "Processing…".
- Recovery: after RPC/Mercury returns, the UI reconciles on the next tick.

| ID | Stress condition | Expected behaviour |
|---|---|---|
| STR-01 | RPC 5xx / timeout | Skeletons + cached values; no blank collateral; auto-recovers |
| STR-02 | Mercury empty post-borrow | Borrow shows on Portfolio row; re-attributes when Mercury catches up |
| STR-03 | Degraded client SAC read | Prior collateral preserved (guard); server feed reconciles |
| STR-04 | Double submit / popup dismissed | Single tx; no stuck processing; idempotent |
| STR-05 | Edge cache cold + burst | Origin does ~1 scan; others served stale-while-revalidate |

### 4.4 Security Testing
- Wallet & signing: every state-changing call needs an explicit Freighter signature; the app never holds keys; no auto-sign.
- Contract auth: `require_auth` enforced on-chain; the frontend cannot bypass risk-engine checks (UI validation is convenience, not the control).
- Input validation: amount fields reject non-numeric, negative, scientific-notation, overflow; fixed-point (WAD/SCALAR_7) conversions use BigInt — no Number scientific-notation parse failures.
- XSS/injection: addresses, symbols, tx hashes rendered as text/links, never HTML; no `dangerouslySetInnerHTML` on untrusted data.
- Secrets: no private keys, RPC admin creds, or BigQuery service-account keys in client bundles or the repo; server-only env vars.
- Transport: HTTPS only; external links `rel="noopener noreferrer"`.
- Dependencies: triage open Dependabot advisories before a pubnet release; pin and patch.
- Financial-attack lenses: oracle manipulation / stale-price handling, re-entrancy (contract side), rounding/precision exploits, liquidation-threshold edge cases.

### 4.5 Usability Testing
- A first-time user can connect, fund (faucet), deposit and borrow without docs; copy is clear (WB vs MB explained).
- Error messages actionable (faucet hint when a token balance is 0; min-XLM-reserve explanation).
- HF and over-borrow feedback immediate and unambiguous (red text, disabled submit).
- Accessibility: keyboard nav, focus states, ARIA labels on icon buttons/toggles, contrast (esp. gradient on text), screen-reader labels on the leverage slider and switches.
- No layout shift on data refresh; stale data stays on screen during background refetch (never `OR isLoading with isFetching`).

### 4.6 Reliability / Resilience
- Data coherence invariant: HF, net-available, collateral-left, debt derived from one source — can never disagree (regression-guard the ∞-over-debt bug).
- Optimistic write + reconcile: a confirmed deposit stays visible through the reconcile; `onPartial` merges (never replaces) collateral so the MB grid can't blank.
- Snapshot staleness: forced post-mutation refresh suppresses the lagging edge feed for one TTL so it cannot clobber fresh values.
- Idempotency: a confirmed tx applied once; retries/replays don't double-count.
- Graceful failure everywhere: loading, empty, and error states on every async surface.

### 4.7 Scalability
- Read path scales with visitors via the edge cache, not origin RPC — verify the per-visitor → per-TTL collapse holds as traffic grows.
- Protocol-wide scans bounded (capped fan-out, memoised pool stats shared across routes).
- Growth in accounts/pools degrades gracefully (pagination, lazy charts) without unbounded client memory.

### 4.8 Compatibility

| Dimension | Coverage |
|---|---|
| Browsers | Chrome, Edge, Brave, Firefox (Freighter-supported); latest + 1 prior |
| Wallet | Freighter extension (desktop) primary; behaviour when absent/locked/denied |
| Devices | Desktop, laptop, tablet, mobile widths; touch + pointer |
| OS | Windows, macOS, Linux; iOS/Android browsers for read-only views |
| Networks | Testnet (full) and Pubnet (Hubble `/stats` enabled); network-mismatch handling |
| Theme | Dark and light parity |

### 4.9 DeFi-Specific Correctness (financial) — highest priority
- Health-factor math verified vs the on-chain Risk Engine across edge cases (no debt → ∞; tiny debt; near-threshold 1.1; multi-collateral).
- APY / exchange-rate / utilisation formulas unit-tested vs reference values; supply-vs-borrow APY relationship holds.
- Fixed-point precision: WAD (1e18), SCALAR_7 (1e7), SCALAR_12 (1e12) round-trips with no drift; BigInt path for large amounts.
- Leverage ↔ borrow identity: `borrow = deposit × (leverage − 1)`; 10X sits at the safe HF edge (~1.11).
- Liquidation thresholds and premium/fee arithmetic exact; no off-by-one at the boundary.
- Oracle: price source, staleness/fallback, USD conversions consistent across margin, earn, analytics.
- Cross-layer consistency: the same account reads identically through `/api/account`, the store, and the Positions table.

---

## 5. End-to-End User Journeys (regression set)

Run on staging (testnet) before every release; a subset becomes the production smoke set.

| ID | Journey | Steps (happy path) | Key assertions |
|---|---|---|---|
| E2E-01 | New user opens a leveraged position | Connect → faucet → deposit XLM (WB) → 3X → borrow → confirm | Position appears instantly; HF finite & correct; Total = Max; history logged |
| E2E-02 | Dual borrow | Deposit → toggle Dual → save → 50/50 split → (execute when `borrow_many` ships) | 50/50 split; no card at 0; no false red; validation correct |
| E2E-03 | Repay to close | Open position → Repay (full) → confirm | Debt → 0; collateral freed; HF → ∞; Repay disabled when clean |
| E2E-04 | Earn deposit/withdraw | Earn → XLM pool → deposit → withdraw | vTokens minted/redeemed; APY & Overall Deposited update; no rounding loss |
| E2E-05 | WB↔MB switch | With collateral on-account → switch to MB | Grid fills instantly (skeleton, never false "no collateral") |
| E2E-06 | Liquidation gating | Healthy then unhealthy → Liquidate | Blocked when HF>1.1; allowed + correct settlement when HF≤1.1 |
| E2E-07 | Analytics read journey | Overview → Oracles → Stress test | KPIs match RPC; oracle fallback badge; stress deltas sane; no NaN/∞ |
| E2E-08 | Resilience | Throttle/kill RPC mid-session | Skeletons + cached values; collateral never blanks; auto-recovers |

---

## 6. Execution, Reporting & Sign-off

### 6.1 Cadence
- Per PR: tsc + ESLint + Vitest unit/integration in CI; affected E2E on staging.
- Per release: full regression (161+ unit, all E2E), performance pass, security/dependency review.
- Production: smoke set + monitoring (RPC health, cache hit-rate, error budget).

### 6.2 Traceability
Maintain a matrix mapping each module/feature (§1.1) to its test IDs (§3–5) so coverage gaps are visible.
Every Critical/High flow must have ≥1 automated unit/integration test plus ≥1 E2E journey.

### 6.3 Known deferrals
- Single-signature multi-borrow execution awaits the contract `borrow_many` / `lend_to` decoupling; dual-borrow UI + validation testable now, execution wires in on contract readiness.
- Hubble-backed `/stats` is pubnet-only; assert it's gated off on testnet.
- Interest-accrued display suppressed to $0 pending `b_rate` verification — track until confirmed.

### 6.4 Sign-off

| Role | Responsibility | Sign-off |
|---|---|---|
| QA / Engineering | Author & execute plan; report defects | Functional + non-functional complete |
| Product | Acceptance scenarios | UAT pass |
| Tech lead | Architecture, security, financial-math review | Release approval |
