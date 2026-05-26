# Onboarding — Rohit (Dev B), Sprint 1 v3.1

> Read this once, top to bottom. It's the fastest path to productive work on the
> Stellar rewire. Last updated 2026-05-27 (after the `new-contract-update` sync).

---

## 0. Get the context into your Claude Code session

Run these in the repo root, then open Claude Code in this folder:

```bash
git fetch origin
git switch feat/stellar-rewire
git pull --ff-only origin feat/stellar-rewire
```

`CLAUDE.md` auto-loads into every Claude Code session in this repo — you don't have
to paste it. To prime your session with the current state, give Claude this prompt:

```
Read CLAUDE.md and ONBOARDING.md and SPRINT_1_GUIDE.md. Then summarise, in your own
words: (1) what shipped in D8–10, (2) what the 2026-05-27 sync changed, (3) the two
locked patterns I must follow, (4) the price-system debt and which day it's fixed,
(5) what's left for D11 and D12. Don't write any code yet — I'll tell you which day
to start.
```

If Claude's summary matches sections 2–5 below, you're aligned. If it doesn't, point
it back at the docs before starting.

---

## 1. What this project is

Vanna's Stellar frontend + on-chain integration. **Next.js (App Router) + TanStack
Query + Zustand**, talking to Soroban contracts via the Stellar SDK + Horizon. Four
live pools: XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC.

The sprint's whole thesis: **the chain tells us when to refetch, not a clock.** A
Horizon SSE stream emits a "tick" on every ledger close (~5 s); reads invalidate on
that tick instead of polling. Read [contexts/ledger-subscriber.tsx](contexts/ledger-subscriber.tsx)
first — everything else hangs off it.

---

## 2. What already shipped (don't redo this)

- **Phase 1 (D1–7, Sanujit solo):** LedgerSubscriberProvider live; all 12 mutation
  sites on `useMutation`; `app/page.tsx` 30s `setInterval` deleted.
- **D8–10 (PR #11 + PR #12, both merged):** 18 read hooks migrated to the
  stable-queryKey + invalidate-on-tick pattern across `use-earn`, `use-margin`,
  `use-farm`, `use-soroswap`, `use-token-prices`. `refetchInterval` count is **0**.
  Bonus: `MarginAccountHydrator` in layout (direct nav to /farm etc. works), RQ
  DevTools (dev-only, bottom-left).
- **Sync (PR #13, 2026-05-27):** `stellar-frontend/new-contract-update` @ `de77db7`
  merged under the rewire — BigInt collateral math, Aquarius reserve-order fix,
  positions/repay calc updates, `capAmountToMaxBalance` swap helper. Build green,
  calc changes manually verified.

---

## 3. The two locked patterns (CLAUDE.md §1–3 is canonical)

**Pattern 1 — ledger-tick reads.** Stable queryKey, invalidate on tick in a
`useEffect`. **Never** put `tick` in the queryKey (it makes a new empty cache slot
every tick → `isLoading: true` flicker every 5 s).

```ts
const qc = useQueryClient();
const { tick } = useLedgerTick();
const lastTickRef = useRef(tick);
const query = useQuery({ queryKey: ['earn', 'pools'], queryFn, staleTime: 4_000 });
useEffect(() => {
  if (tick === lastTickRef.current) return;
  lastTickRef.current = tick;
  qc.invalidateQueries({ queryKey: ['earn', 'pools'] });
}, [tick, qc]);
```

**Pattern 2 — mutations.** `useMutation` with `onSuccess: () => qc.invalidateQueries(...)`.
No manual `refreshAllBalances()` / `triggerBlendRefresh()`.

**Pattern 3 — loading flags.** Return `isLoading: query.isLoading` **only**. Never
`|| query.isFetching` — that flickers content on every background refetch.

> ⚠️ The "Hook tick pattern" recipe block lower in SPRINT_1_GUIDE.md and in the
> Notion page still shows the OLD `queryKey: [..., tick]` anti-pattern. It's wrong.
> Trust CLAUDE.md §1.

---

## 4. Known debt from the sync — fixed in D12 (don't make it worse)

The sync brought in `contexts/price-context.tsx` — a `PriceProvider` that polls XLM
price on a **60 s `setInterval`**. That's the exact chain-data polling anti-pattern
this sprint removes, but we kept it so the sync's calc changes work. So right now
**two token-price systems coexist:**

| System | File | Mechanism | API |
| --- | --- | --- | --- |
| Ours (keep) | `hooks/use-token-prices.ts` | ledger tick | `useTokenPrices(tokens[])` → price map |
| Upstream (retire in D12) | `contexts/price-context.tsx` | 60s `setInterval` | `useTokenPrices()` → `{prices,getPrice,xlmUsd,…}` |

7 files import **both** (the second aliased `useTokenPricesFromHook`).

**Until D12:** do **not** add new `PriceProvider` consumers. Use
`hooks/use-token-prices.ts`. D12 collapses the poll onto the tick and drops the dual
API so there's one source of truth.

---

## 5. What's next — your near-term days

- **D11 — refreshKey teardown (+ 4-pool verify).** D8 already removed all 8
  hook-level `refreshKey` reads. D11 only needs to: delete `triggerBlendRefresh()`
  callers in `components/farm/add-liquidity.tsx` + `remove-liquidity.tsx`, drop the
  `refreshKey` reads in `app/farm/[id]/page.tsx`, delete `refreshKey` + `triggerRefresh`
  from `store/blend-store.ts`. Target: `grep -rn "refreshKey\|triggerRefresh" .` empty.
- **D12 — kill remaining polling + first smoke.** Delete `lib/hooks/useSmartPolling.ts`
  and its import in `app/margin/page.tsx`; **reconcile the price system** (section 4);
  then a full testnet smoke across all 4 pools. Target: `grep -rn "setInterval" contexts/` empty.

- **D22 — analytics-island rework (NEW, pulled into S1).** The whole `app/analytics/*`
  surface is a pre-rewire island: bespoke imperative store, 5 pages on 30s `setTimeout`
  polling, an unbounded all-accounts × per-token RPC fan-out. D22 brings it onto
  Mercury/Hubble/tick (and retires the unbounded read). Rides the Mercury work.
- **D25 — stats snapshot-cache layer (NEW, pulled into S1).** The cold-load of
  *every* stats panel (Margin HF/collateral/borrowed, Earn vault stats + positions,
  Farm pool stats + LP, Portfolio summary) is slow because each reads live chain
  state on first paint. Fix: edge-cached snapshot routes — `/api/account/[addr]`
  (per-user) + `/api/pools` (shared) — read via the ledger-tick RQ pattern so the
  client gets an instant cached snapshot and refreshes silently. **Goal: all stats
  render < 1 s on warm cache.** Dev A = account snapshot; Dev B = pool snapshot +
  analytics memoization.

Full day-by-day (D13 test infra → D30 integration) is in
[SPRINT_1_GUIDE.md](SPRINT_1_GUIDE.md). Mercury (D20–22) and Hubble (D23–24) both run
on **free tiers** — no payment decisions in this sprint.

> **Note on stats speed:** Mercury/Hubble do **not** speed up the live stats panels —
> Mercury is event *history*, Hubble is protocol-wide *analytics*. The live per-account
> stats fetch fast only via the D25 snapshot-cache layer above.

> **Read before you start any cleanup day:** [CODEBASE_AUDIT.md](CODEBASE_AUDIT.md) is the
> full health audit — every known perf/reactivity/correctness issue with file:line,
> severity, and the exact day it's scheduled. Check it before D11/D12/D16–17/D22/D25/D26
> so you're fixing the catalogued item, not rediscovering it. It also lists the
> drop-first buffer that protects D30.

---

## 6. Working agreements

- Branch from `feat/stellar-rewire` (not `main`). Branch names: `s1/<topic>`.
- One PR per phase branch → squash-merge into `feat/stellar-rewire`.
- Must pass `npm run lint && npm run build` before PR. (Heads up: the TS-check phase
  is memory-hungry — use `NODE_OPTIONS=--max-old-space-size=8192` if it OOMs.)
- Conventional commits with scope (`refactor(scope): …`). No AI-tool references in
  commits/PRs/comments. Professional tone.
- TypeScript strict, no `any`. Comment only non-obvious WHY. Delete dead code, no shims.

Questions on intent live in [SPRINT_1_GUIDE.md](SPRINT_1_GUIDE.md) and the
[Notion plan](https://www.notion.so/Sprint-1-Plan-Frontend-Rewire-2-Dev-Split-36042874c59b80e7a81fdec4d85eb0d7).
When in doubt about a pattern, CLAUDE.md wins.
