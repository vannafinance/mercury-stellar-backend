# Handoff — `compileProposal` and the first two workflow routes

Written for an implementer who has not read this codebase. Everything below was verified
against the source on 2026-09-09; every type is quoted from the file that defines it.

Audit afterwards: `npx tsc --noEmit`, `npx vitest run` (baseline **1415 passed, 2 skipped**),
`npx eslint <changed files>`. Do not commit or push — the owner commits.

---

## 0. Corrections to the spec you may have been given

A previous spec for this task contained three errors that would compile fine and then fail
at runtime. Verified against source:

| Claim in that spec | Reality |
| --- | --- |
| Tools are `soroban.deposit_collateral`, `blend.supply`, `blend.borrow` | **No such tools.** Every MCP tool is `vanna_*`. The real names are in the mapping table in §4, taken from `lib/copilot/mcp-write.ts`. |
| `args` hold "raw token amounts in stroops/base units, token addresses" | **No.** Write tools take a *display* token amount as a **string** (`"10"` = 10 XLM) plus `symbol`, `smart_account`, `trader`. There is no decimals conversion and no token address. See `mcp-write.ts:538-540`. |
| `tokenAmount = (usdAmount / tokenPriceUsd) * 10^decimals` | Wrong unit (above) **and** wrong arithmetic. JS float division reintroduces a bug already fixed once here: `(1.3).toFixed(18)` is `"1.300000000000000044"`, and that noise previously let a health floor of exactly 1.1 slip past a guard. Use the WAD BigInt helpers in `lib/copilot/investigation/fixed.ts`. |
| `compileProposal` returns `proposalDigest` | Don't. `WorkflowJournal.create()` computes the digest over the whole proposal. A second digest from the compiler creates two competing identities for one plan. |
| `resolvePrivySignerId` is in `lib/wallet-adapter.ts` | It is in `lib/copilot/wallet-bind.ts:129`. |

---

## 1. What exists already (do not rebuild)

- `lib/copilot/investigation/sizing.ts` — `sizeLegs` sizes legs against a health-factor
  floor and **checks every intermediate state**, so a plan that ends healthy but passes
  through a liquidatable state is rejected. Amounts are exact WAD BigInt.
- `lib/copilot/investigation/candidates.ts` — `generateCandidates` enumerates and ranks
  shapes; rejects negative and break-even carry with a reason; honours an amount the user
  named outright.
- `lib/copilot/workflow/journal.ts` — the full state machine, 21 tests:
  `create` → `approve` → `claimNext` → `invocationResult` → `settled`, plus `reconcile` and
  `cancel`. Every write is compare-and-set, so neither a repeated POST nor another replica
  can claim a leg twice.
- `lib/copilot/workflow/store.ts` — `LocalRecordStore` (dev, encrypted append-only) and
  `FirestoreRecordStore` (Cloud Run). `workflowStore()` **throws** in production when
  unconfigured rather than falling back to a process-local map.

**Nothing under `app/` references the journal.** That is the gap this handoff closes.

---

## 2. The exact types you must satisfy

From `lib/copilot/workflow/types.ts`:

```ts
export type WorkflowOp = "lend" | "deposit_collateral" | "borrow" | "repay" | "supply_blend";

export interface ProposalStep {
  id: string;
  op: WorkflowOp;
  asset: string;
  amount: string;      // display token amount, positive decimal, e.g. "10" or "6541.043333"
  label: string;
  tool: string;        // a real vanna_* tool name — see §4
  args: Record<string, unknown>;
  sizing?: StepSizing; // absent means "stated" — read §5 before omitting it
}

export type StepSizing =
  | { basis: "stated" }
  | { basis: "derived_max_at_floor"; minAmountUsd: string };
```

`journal.create()` refuses a step whose amount is not `/^\d+(\.\d+)?$/` or is `<= 0`
(`unsized_proposal_step`). `"max"`, `""`, `"0"`, `"1e3"` are all refused.

From `lib/copilot/investigation/candidates.ts`:

```ts
export interface Candidate {
  id: string; label: string; borrows: boolean;
  asset: RateComparison["asset"];
  venue: "blend";                     // only value today
  netAprPct: string | null; supplyAprPct: string;
  legs: SizedLeg[];                   // READ THE WARNING BELOW
  finalHealthFactor: string | null;
  amountUsd: string;                  // USD, not tokens
  evidenceIds: string[];
}
```

From `lib/copilot/investigation/sizing.ts`:

```ts
export type SizedOp = "deposit_collateral" | "borrow" | "repay" | "withdraw_collateral";
export interface SizedLeg {
  op: SizedOp; label: string; amountUsd: string;
  grossAfterUsd: string; debtAfterUsd: string;
  healthFactorAfter: string | null;
}
```

### ⚠ `candidate.legs` does not contain the supply leg

This is the single most important thing in this document and the easiest to get wrong.

`legs` holds only operations that **move collateral or debt**. Supplying borrowed proceeds
into Blend is treated as health-factor *neutral* — the measured reason is in the
`candidates.ts` header: the borrowed proceeds become a Blend tracking receipt that the
contract still counts as collateral, so the health projection comes from the borrow leg
alone. Consequently:

- `borrow_supply_<ASSET>` has **exactly one** leg (`op: "borrow"`), and the Blend supply that
  the label promises **is not in the array**. The compiler must add it as a second step.
- `supply_idle_<ASSET>` has **`legs: []`** entirely, because committing idle wallet value
  touches neither margin collateral nor debt. Its only step is a Blend supply, and its
  `finalHealthFactor` is `null`.

A compiler that just maps `legs` produces a plan that borrows and never supplies. Guard this
with a test (§6).

The two candidate shapes are also the only ones today: `SizedOp` values `repay` and
`withdraw_collateral` are reachable through `sizeLegs` but no generator emits them, so
either map them properly or refuse them explicitly — do not silently drop a leg.

---

## 3. Signature

Put it in `lib/copilot/investigation/compile.ts`.

```ts
export type CompileResult =
  | { ok: true; steps: ProposalStep[] }
  | { ok: false; reason: "missing_price" | "stale_price" | "unpriceable_amount"
      | "unsupported_venue" | "unsupported_op" | "zero_amount" };

export function compileProposal(input: {
  candidate: Candidate;
  scope: InvestigationScope;          // has trader + smartAccount
  observations: readonly Observation[];
  floor: string | null;               // the user's stated floor, from ResearchCapacity
  now: number;
}): CompileResult;
```

A discriminated union, not an interface with a union body — the shape in the older spec is
not valid TypeScript.

Return the reason rather than throwing, and rather than a partial step list. A caller that
receives `ok: false` shows the user why no plan could be built; a caller that receives half a
plan may execute half a strategy.

---

## 4. USD → token, and the tool mapping

**Price source.** Only a price read in the *same* investigation counts. `candidates.ts` has a
private `freshPrices(observations, now)` (60s window, skips a zero or unparseable price) —
export it and reuse it. Do not add a second freshness rule: `idleWalletUsdFrom` and
`requestedBorrowFrom` already both use this one, and a third would drift.

If the price for `candidate.asset` is absent → `missing_price`. Outside the window →
`stale_price`. **Never** substitute a fallback, and never treat a stable's ticker as exactly
$1.00 — a $1 assumption flows straight into a health-factor check the user is relying on.

**Arithmetic.** WAD BigInt only, via `lib/copilot/investigation/fixed.ts`
(`decimalWad`, `formatWad`, `divDown`/`mulDown`, `WAD`). Token amount is
`usdWad * WAD / priceWad`, rounded **down** — rounding up can request more than the account
can fund. Then `formatWad`, and assert the result matches `/^\d+(\.\d+)?$/` and is `> 0`
(else `zero_amount`) *before* handing it to `create()`, so the failure is a typed reason
rather than a thrown `unsized_proposal_step`.

**Mapping**, from `mcp-write.ts` (all args verified there):

| Candidate leg / step | `op` | `tool` | `args` |
| --- | --- | --- | --- |
| `SizedLeg.op: "deposit_collateral"` | `deposit_collateral` | `vanna_deposit_collateral` | `{ smart_account, symbol, amount, trader }` |
| `SizedLeg.op: "borrow"` | `borrow` | `vanna_borrow` | `{ smart_account, symbol, amount, trader }` |
| `SizedLeg.op: "repay"` | `repay` | `vanna_repay` | `{ smart_account, symbol, amount, trader }` |
| the Blend supply the candidate implies (§2) | `supply_blend` | `vanna_blend_supply` | `{ smart_account, symbol, amount, trader }` (verified at `mcp-write.ts:933-941`) |
| `SizedLeg.op: "withdraw_collateral"` | — | — | no `WorkflowOp` exists; return `unsupported_op` |

`amount` is a **string** in display units. `symbol` is the wire symbol — take it from
`candidate.asset`, never from the user's wording. (A card once said BLUSDC while buying
AQUSDC because the label was built from the user's word.)

`candidate.venue` is `"blend"`; anything else → `unsupported_venue`.

Two notes on the Blend supply, both from that call site:

- The symbol is Blend's own (`blendSym`), which is not always the candidate's symbol — Blend's
  USDC maps to `BLUSDC` and never to `AQUSDC`. Reuse the existing symbol resolution rather
  than passing `candidate.asset` straight through.
- The tokens must already be **free inside the margin account** (the C-address), not merely in
  the wallet. That is why the borrow step must precede the supply, and it is the real reason
  for the ordering rule in §6.8 — not the health factor, which `sizeLegs` already guarantees.


---

## 5. `sizing` — get this right or the re-size guard misfires

`claimNext` re-checks readiness before each step is broadcast and may re-derive an amount
*within a bound*. Which behaviour a step gets depends entirely on the `sizing` you set:

- The amount came from the user's own words (`requestedBorrowFrom` produced it) →
  `{ basis: "stated" }`. `claimNext` will then **stop** rather than re-size, because
  shrinking a stated 500 to 430 carries out a different instruction.
- The amount was derived from the floor (`amountUsd: "max"` resolved by `sizeLegs`) →
  `{ basis: "derived_max_at_floor", minAmountUsd }`. `claimNext` may re-derive downward, but
  never above the approved amount and never below `minAmountUsd`.

`minAmountUsd` is a **product decision, not a default to invent.** It is the point below
which the position is materially different from the one approved. Do not silently pick a
fraction; surface it in the plan card so the user approves the range, and ask the owner what
it should be. Getting this wrong in either direction is bad: too low and the health floor
stops being a stop condition and becomes a slider, since some amount always fits; too high
and a normal price wobble strands a half-executed plan holding borrowed money that pays
interest and earns nothing.

Steps with no floor (`floor === null`) must be `"stated"`.

---

## 6. Tests to write (`tests/lib/investigation-compile.test.ts`)

Mirror the style of `tests/lib/investigation-candidates.test.ts`: comments state the
judgement being pinned, not the mechanics.

1. **The supply leg is emitted.** `borrow_supply_BLUSDC` compiles to **two** steps —
   `borrow` then `supply_blend` — even though `candidate.legs` has one entry. This is the §2
   trap; without this test a borrow-and-never-supply plan ships.
2. **`supply_idle_*` compiles to one `supply_blend` step** from `legs: []`.
3. **USD → token uses the read price.** $6,541.04 of XLM at $0.19 → the exact WAD quotient,
   rounded down. Assert the full string, not a rounded comparison.
4. **No price → `missing_price`; stale price → `stale_price`.** No fallback, no $1 peg for a
   stable (assert a USDC-family asset with no price read still refuses).
5. **`sizing` basis is carried correctly** — a stated amount compiles to `"stated"`, a
   floor-derived one to `"derived_max_at_floor"` with the bound.
6. **Every emitted step survives `journal.create()`** — call it with a fake store and assert
   no `unsized_proposal_step`. This is the contract that matters; a compiler that produces
   steps `create()` rejects is not done.
7. **`withdraw_collateral` returns `unsupported_op`**, not a dropped leg.
8. **Ordering**: collateral-increasing steps precede the borrow. Note the safety invariant is
   *already* enforced by `sizeLegs` (it checks every intermediate state), so this test pins
   the readable order, not the safety — do not re-implement the health check here.

---

## 7. Routes

Both under `app/api/copilot/workflow/`. Copy the security preamble from
`app/api/copilot/investigate/route.ts` verbatim in shape — it is the reviewed pattern:
origin check, `loadUserFromRequest` → 401 when unbound, strict body allowlist (reject any
unexpected key), `withBoundUser`, `runtime = "nodejs"`, `dynamic = "force-dynamic"`.

**`POST /propose`** — body: `{ continuation, candidateId }` and nothing else.
Re-open the continuation with `researchCodec` to recover the scope, re-resolve scope, verify
it matches the bound subject, re-run the investigation's deterministic parts to obtain the
candidate (do **not** trust a candidate posted by the browser — the client may not supply
amounts, tools or args), `compileProposal`, then `journal.create()`. Return `workflowView`.

**`POST /[id]/approve`** — body: `{ revision, digest }` and nothing else.
Call `journal.approve(id, identity, revision, digest, validate)`. `validate` re-reads the
position and returns a **reason string** if anything moved materially, else `null`. It is
already wired to consume approval on failure — a blocked plan requires a new proposal, never
an implicit approval.

Never accept `args`, `tool`, `amount` or a signed/unsigned XDR from the browser. The journal
holds the canonical plan; the client may only reference it by `id`, `revision` and `digest`.

---

## 8. Out of scope — do not do these

- **Do not convert the workspace into a chat feed.** A previous report recommended an
  append-only message stream; the owner has ruled against it explicitly. It stays a copilot
  page: command bar, telemetry, structured cards.
- **Do not touch the Margin page, `lib/account-snapshot.ts`, or anything outside the
  copilot.** Standing instruction from the owner; `dev` is authoritative and correct apart
  from the copilot.
- **Do not add LP shapes.** Borrow guards skip Aquarius LP receipts while the total-balance
  path prices them, so their collateral value is unvalidated.
- **Do not request or apply the Firestore IAM grant.** It was refused once; only the owner
  applies it.
- **Do not remove or weaken `executionAllowed: false`** on the research view. Execution
  enters only through journal approval.

## 9. Interim code you are replacing

`copilot-workspace.tsx` has an effect commented *"Act on what was understood"* that posts the
original prompt to the legacy executor once per sealed continuation. It exists because the
surface was otherwise a dead end — every prompt investigated and then nothing happened. It
re-derives its own steps rather than executing the sized candidate, which is exactly what
`compileProposal` fixes. Replace it in step 4 of the plan; leave it working until `/propose`
and `/approve` are live, so the page never regresses to the dead end.
