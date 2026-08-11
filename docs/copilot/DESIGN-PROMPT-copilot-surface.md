# Design prompt — the whole copilot surface

One prompt covering **all three cards** so they come out in a single design language.
Supersedes `DESIGN-PROMPT-answer-card.md` (kept for reference; do not generate from it
alone, or the answer card will diverge from its siblings again).

Paste everything inside the fence into Claude and ask for artifacts.

---

## Read this first: why one prompt, not three

The three cards each define their **own** colour ramp, and two of them are off-brand:

| Namespace | Card | Hardcoded hex declarations in `globals.css` |
|---|---|---|
| `--cp-*` | answer card | **0** — every value is a `var()` alias of the brand palette |
| `--pc-*` | plan approval card | **64** |
| `--rc-*` | run execution card | **74** |

`--rc-accent: #4b1bc4` and `--pc-heading: #0e1116` are not in the brand palette
(`--violet-500: #703ae6`, headings `#1F1F1F`). That is 138 independent hex values across
one surface, which is the actual reason it does not read as one product — and it cannot be
fixed card by card.

So the prompt below mandates a **single** token set for anything newly designed.

> ### Amendment, 2026-08-12 — do not collapse the two cards onto the brand ramp
>
> This section originally instructed that wiring should collapse `--pc-*` and `--rc-*`
> onto brand-aligned aliases, "zero hex literals". That was written before anyone
> measured the merge. It was then measured, exhaustively, and **it costs contrast on the
> two safety-critical cards**, so it was not done and should not be done later by someone
> tidying up:
>
> - None of the 75 card tokens holds the same value as a page token in **both** themes.
>   Exactly one role (the white button label) is even perceptually indistinguishable.
> - The venue and status colours are ΔE 13–30 from their nearest brand token — a different
>   palette, not a variant of one. The card ramp was contrast-measured against a **card**
>   surface and is opaque (`#ede6fd`); the page ramp is translucent over the **page**
>   (`rgba(112,58,230,.10)`).
> - Merging would cost, measured on the card surface: earn ink 8.8:1 → 5.3:1, farm
>   9.2 → 5.9, danger 9.3 → 5.2, margin 11.3 → 7.0. Still AA, but these are the approval
>   gate and the live run for transactions that move real money.
>
> What *was* done instead, and what "one token set" now means here: the two cards share a
> single `--card-*` layer, so there is one palette rather than two hand-maintained copies,
> and all 75 `--pc-*` / `--rc-*` names are aliases declared once and never per theme. The
> literals that remain are 44 canonical values for the card layer, down from 138 spread
> across four blocks. The shell's greys were moved onto the design's ramp separately, by
> aliasing the names Tailwind resolves.
>
> Full mapping, every value and every contrast figure: **`TOKEN-MAP-cards.md`**.
>
> Two things §2's palette turned out to be missing, both now added rather than worked
> around: an `ok` status trio (`--ok-fg/-bg/-bd`) to sit beside `warn` and `danger` — its
> absence is why "settled" was painted with the raw emerald mark at 2.54:1 — and the
> distinction between a status **ink** (for text) and a status **mark** (bright, for dots
> and bars). The bright hues in §2 fail AA as text: emerald 2.54:1, amber 2.15:1,
> imperial 3.21:1 on white. Use them for marks, not for labels.

---

```
You are designing the complete UI for the Vanna Finance AI copilot — a natural-language
interface to a DeFi margin/lending protocol on Stellar. I need production-quality React
components, delivered as artifacts I can view and judge.

There are THREE cards. They live on the same screen, one after another, and today they
look like three different products. Your job is to design them as ONE system: shared
primitives, shared rhythm, shared vocabulary. Design the primitives first, then the cards
out of them.

## 0. Hard constraint — one token set

Every colour must be a CSS custom property from a SINGLE namespace you define (use
`--cp-*`). No component may introduce a hex literal. This matters concretely: the current
code has 138 hardcoded hex values spread across two private ramps, and that is why the
surface is incoherent. Every token must trace back to the brand palette in §2.

Both light and dark themes are required. Define the ramp once and re-map it under a
`[data-theme="dark"]` selector — not per component.

## 1. The surface, top to bottom

A two-column layout. Main column ~620px. Right rail (~320px) shows live account stats:
health-factor gauge, collateral, debt, open positions, autonomy/signing status.

The main column shows a numbered vertical flow, each step with a small monospace uppercase
eyebrow at wide letter-spacing:

  01 · YOUR INTENT      the prompt the user typed, plus a composer
  02 · AGENT RUN        a live timeline: "Intent parsed → MCP tool call → Response
                        composed", each row with a status dot and a mono right-hand label
                        like `query_all_earn_pools`, `vanna_get_pool_stats`
  03 · one of the three cards below
  SESSION LOG           a compact history list of previous turns

## 2. Brand system — exact values, use only these

Font: Plus Jakarta Sans for all prose. Monospace stack for every number, ticker,
percentage, address and tool name.

Type scale (headings semibold 600, body regular 400):
  H7 24/36 · H8 20/36 · H9 16/24 · H10 14/21 · H11 12/18 · H12 10/15
  Body1 16/24 · Body2 14/21 · Body3 12/18 · Body4 10/15

Palette:
  violet-500 #703AE6 (primary) · violet-50 #F1EBFD · violet-100 #D3C2F7 · violet-300 #9F7BEE
  rose-500 #FF007A (second primary)
  imperial-red-500 #FC5457 (danger / negative / sell)
  electric-blue-500 #32EEE2 (success)
  gray 50 #F4F4F4 · 100 #DFDFDF · 200 #BFBFBF · 300 #A9A9A9 · 400 #949494 ·
       500 #777777 · 600 #595959 · 700 #2C2C2C · 800 #1E1E1E · 900 #111111
  base white #FFFFFF · base dark #111111 · platinum #F7F7F7
  gradient: linear-gradient(135deg, #FC5457 10%, #703AE6 80%)  — primary CTAs only

Text: headings #1F1F1F · paragraphs #4B5563 · placeholders #9CA3AF · borders #E5E7EB
Radius: 4 / 8 / 12 / 16 / 20 / 24 / full
Spacing (px, use ONLY these): 2 4 8 12 16 20 24 32 40 48 56 64 72 80 120
Shadow: 0 7px 15px rgba(0,0,0,.08), 0 28px 28px rgba(0,0,0,.07)
Buttons: semibold; primary = gradient or violet-500; radius 8–16.

## 3. Shared primitives — design these once, reuse in all three cards

1. **Eyebrow** — mono, uppercase, ~10.5px, letter-spacing .2em, muted.
2. **Venue badge** — a pill naming which product a thing touches. Four venues, each with
   its own fg/bg/border triplet: MARGIN, EARN, FARM (Blend/Aquarius), WALLET. Colour must
   mean exactly one thing across the whole surface.
3. **Figure** — a number. Monospace, tabular numerals, so figures align down a column.
4. **Identifier** — a 56-character Stellar address (starts G or C) or a 64-char hex tx
   hash. Must be shown IN FULL and be copyable. Never truncated. See §7.1.
5. **Status mark** — carries leg state by SHAPE as well as colour: dashed ring (pending),
   square (staged), pause bars (waiting on user), spinner (in flight), check (settled),
   cross (failed). Colour alone is not enough — see §6.4.
6. **Tone** — neutral / good / warn / bad, applied to a figure or a row.
7. **Button set** — primary (gradient), secondary (outline), quiet (text), and a
   destructive variant. Plus a disabled and a busy state.

## 4. CARD A — Answer (a read)

Props: `{ answer: StructuredAnswer }`

  interface AnswerFact { label: string; value: string; tone?: "neutral"|"good"|"warn"|"bad" }
  interface StructuredAnswer {
    headline: string;                 // one sentence, leads with the figure asked for
    facts: AnswerFact[];              // 0 to ~16, MIXED figures and identifiers
    note?: string;                    // ≤ 2 sentences
    venue?: "earn"|"blend"|"aquarius"|"margin"|"wallet"|"oracle"|"none";
  }

Real payloads — design for the hardest, not the easiest:

(a) 16 identifiers (the case that currently breaks):
  headline "Vanna Finance protocol contract addresses retrieved."
  REGISTRY = CBBQQULN3XZDWDZG7D6VYD4UQKBGYH22DOFQEISKENCMZTYUPQ5LDXUO
  ACCOUNT MANAGER = CAZLR6EHZXQNZJIFNP6F7SIJQC3P64MKHHQNZSSG5BNAEFCYTTGTDZXB
  RISK ENGINE, ORACLE, RATE MODEL, LENDING POOL XLM, LENDING POOL BLUSDC,
  XLM CONTRACT, USDC CONTRACT, OPTIONAL TRACKING TOKEN … (all 56 chars)
  note "Includes system contracts for risk management, price feeds, and lending pools."

(b) A 4-row comparison, 5 figures per row — currently an unscannable wall:
  headline "BLUSDC pays more for supplying: 13.97% vs 1.03% on XLM — 12.94 points apart."
  XLM     supply 1.03%   borrow 6.01%   used 17.18%   28,708.37 XLM supplied   23,676.55 available
  BLUSDC  supply 13.97%  borrow 22.11%  used 63.18%    5,124.83 BLUSDC          1,886.88
  AQUSDC  supply 8.20%   borrow 16.95%  used 48.42%    3,595.93 AQUSDC          1,854.88
  SOUSDC  supply 0.07%   borrow 1.58%   used  4.51%   21,093.75 SOUSDC         20,141.76
  venue "earn"

(c) Tone carries meaning:
  headline "Health factor 2.89 — healthy. Liquidates at 1.10; your floor is 1.30."
  HEALTH FACTOR 2.89 (good) · COLLATERAL $1,491.96 · DEBT $517.21 (warn) ·
  COLLATERAL LEFT BEFORE LIQUIDATION $1,220.27 · venue "margin"

(d) Two states of one number:
  headline "After borrowing 10 BLUSDC ($10.00), your health factor would be about 3.14 —
  down from 3.19."

(e) Headline only, no facts: "XLM is trading at $0.1603." venue "oracle"

## 5. CARD B — Plan approval (before anything executes)

The safety-critical card. The user reads it, then approves, and what executes is exactly
what was shown. It must be trustworthy at a glance.

Props: `{ plan, onApprove, onModify, onCancel, busy, autoPending }`

  interface PlanStepView {
    n: number;
    kind: "write" | "read";           // a read leg needs NO signature
    op: string;                       // "deposit_collateral", "borrow", "deploy_to_blend"
    label: string;                    // "Deposit 300 XLM on your margin account"
    asset: string | null;
    amount: number | null;
    fraction: number | null;          // 0.25 → show "25%" when amount is null
    leverage: number | null;
    borrow_asset: string | null;
    venue: "earn"|"margin"|"farm"|"wallet"|"other";
  }
  interface FrozenPlan {
    plan_id: string;                  // short fingerprint, e.g. "1127d75d3d…34b"
    summary: string;
    steps: PlanStepView[];
    created_at: number;               // plan EXPIRES 5 minutes after this
    signature_count: number;          // LEGS, not steps — a levered step signs twice
    warnings: string[];
  }

Real payload:
  summary "Multi-step strategy: 1) deposit_collateral 300 XLM → 2) borrow 30 BLUSDC →
           3) deploy_to_blend 29.895 BLUSDC → 4) report account health"
  step 1  MARGIN  deposit collateral  "Deposit 300 XLM on your margin account"      300 XLM
  step 2  MARGIN  borrow              "Borrow 30 BLUSDC on your margin account"      30 BLUSDC
  step 3  FARM    deploy to blend     "Supply 29.895 BLUSDC into Blend"          29.895 BLUSDC
  step 4  OTHER   report              "Report account health"                    no signature
  "4 steps · 3 signatures · margin → farm"
  warnings ["3 separate signatures — the plan stops if you cancel partway."]
  a live countdown: "04:39 QUOTE VALID"

Also design: a share-sized step (`fraction: 0.25` → the amount cell reads "25%"), and a
levered step whose warning explains it runs as two transactions.

Must be obvious: how many signatures, which venues, what expires when, and that a read leg
signs nothing.

## 6. CARD C — Run execution (live, while money moves)

ONE card that advances in place — never a new card per leg. This is the only thing on
screen while three signed transactions move real money, so narration is the product.

Props: `{ legs, hf, floor, liquidation, busy, eyebrow, ... }`

  type RunLegStatus = "pending" | "staged" | "needs_sign" | "running" | "ok"
                    | "needs_input" | "failed" | "skipped";
  interface RunLeg {
    n: number; venue: RunVenue; op: string; label: string;
    amount: string | null; asset: string | null; leverage?: number | null;
    status: RunLegStatus;
    hash?: string | null;             // 64-char tx hash once submitted
    elapsed?: string | null; error?: string | null;
    question?: string | null; hint?: string | null;   // when status is needs_input
  }

Status copy already in use — keep the meaning, improve the presentation:
  pending "pending" · staged "staged · xdr built" · needs_sign "waiting on your signature"
  running "confirming on ledger (testnet can take ~30–60s)" · ok "settled"
  needs_input "paused · needs input" · failed "failed" · skipped "skipped"

Card-level states to design, each with a headline and a progress indicator:
  "0 of 3 settled — Leg 1 is built and waiting for you to sign"
  "1 of 3 settled — Leg 1 settled · leg 2 of 3 still pending. Waiting for auto-resume."
  "2 of 3 settled — Supply 29.895 BLUSDC to Blend · submitted to the ledger"
  "RUN COMPLETE · 3 of 3 settled — Every leg settled. 3 transactions on chain. Nothing is
   left in flight."
  a failed run, and a run stopped to protect the health-factor floor.

Also design: a health-factor gauge (value, a liquidation threshold at 1.10, the user's own
floor at 1.30, a healthy band 3.0+), and a settled leg showing its full tx hash.

## 7. Failures in the current UI. Do not reproduce them.

1. **Truncated identifiers.** Addresses rendered as "CBBQQULN…5LDXUO". "Is this the right
   contract?" is the only question anyone asks of a protocol address, and a shortened one
   cannot answer it.
2. **Collapsing labels.** A 56-char value forced through a `1fr auto` grid stretched the
   value column until "REGISTRY" wrapped one letter per line — "REG / IST / RY".
3. **No hierarchy at volume.** Sixteen facts rendered as sixteen identical rows; nothing
   scannable.
4. **Status legible by colour only.** A colour-blind user could not tell a settled leg from
   a pending one.
5. **Internal plumbing shown as data.** Rows like FUNCTION / CONTRACT / SIMULATION SUCCESS /
   AUTO SIGN ERROR / raw stroop fee estimates sat beside the two figures that mattered.
   Design an affordance for "details for whoever debugs this" that is not the default view.
6. **Three private colour ramps.** See §0.

## 8. What "good" means, in priority order

1. **A user can act without reading everything.** The headline figure, the signature count,
   the run's progress — each visible in one glance.
2. **Nothing overstates certainty.** A leg is never styled as done before it is done; a
   projected number never looks like a settled one.
3. Identifiers fully readable and copyable without breaking layout.
4. Figures align down columns so sets can be compared.
5. WCAG AA (4.5:1), state carried by shape as well as colour, visible focus, keyboard
   operable, semantic HTML (`dl/dt/dd` for description lists, `ol` for ordered legs).
6. Calm and dense-but-not-cramped. Financial-instrument precision, not a chat bubble.
7. Motion only where it means something — a spinner for in-flight, nothing decorative.

## 9. Deliver

- Artifact 1: the primitives from §3 as a small library, plus the light/dark token block.
- Artifact 2: the three cards built from those primitives, rendering ALL the real payloads
  in §4–§6 stacked, with a light/dark toggle so I can check both.
- React + Tailwind utilities; inline `style` only to reference CSS variables. Only
  dependency: `lucide-react`.
- Real strings only — no lorem, no placeholder addresses.

Before the code, briefly state your system decisions: the token names, how a figure differs
from an identifier, how you build hierarchy at 16 facts, and how status reads without
colour.
```

---

## Wiring notes

| Card | File | Props today |
|---|---|---|
| Answer | `components/copilot/answer-view.tsx` | `{ answer: StructuredAnswer }` |
| Plan approval | `components/copilot/plan-approval-card.tsx` | `{ plan, onApprove, onModify, onCancel, busy, autoPending }` |
| Run execution | `components/copilot/run-execution-card.tsx` | `{ legs, hf, floor, liquidation, busy, … }` |

All three already receive exactly the data the prompt describes, so a component matching
the interfaces drops in without touching the brain.

**The token collapse is the part to get right** — and it is now done; see the amendment
in §0 for what shape it took and why it is not the shape this section originally asked
for. It was landed as its own commit before any component swap, so a visual regression
stays attributable to the ramp rather than to a redesign.

Keep: the identifier/figure split, status-by-shape, `FactsGrid`'s `shown` de-duplication,
and read legs counting zero signatures. Each of those is a bug that already happened once.

After wiring: `npx tsc --noEmit` and `npx vitest run` clean, then check `/copilot` in both
themes with "show me the protocol contract addresses" (16 identifiers), a 4-leg plan, and a
live multi-leg run.
