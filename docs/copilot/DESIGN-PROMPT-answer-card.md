# Design prompt — Copilot answer card

Paste everything inside the fence into Claude (claude.ai) and ask for an artifact. It is
written so the output can be wired into `components/copilot/answer-view.tsx` mechanically:
the variables it names already exist in `app/globals.css`.

Reuse the same shape for other copilot surfaces — swap §3 (data contract) and §4 (real
content) for that surface's payload and examples.

---

```
You are designing one component for Vanna Finance, a DeFi margin/lending protocol on
Stellar. I need a production-quality React component, delivered as an artifact I can view.

## 1. What this component is

The ANSWER card of an AI copilot. A user asks a question in plain English ("what's my
health factor?", "show me the protocol contract addresses", "compare the XLM and BLUSDC
pools") and this card renders the reply.

It sits inside an existing card in a two-column app layout: main column ~620px wide, a
right rail showing account stats. Directly above the card is a small monospace eyebrow
reading "03 · ANSWER". Sibling cards on the same surface (a plan-approval card, a live
run card) already use: monospace uppercase eyebrows with wide letter-spacing, pill-shaped
venue badges, 12–16px radii, 1px hairline borders.

This is a READING surface. Someone scans it for one number, or checks one address against
a deployment. It is not a dashboard and not a form.

## 2. Brand system — use these exact values

Font: Plus Jakarta Sans for all prose. A monospace stack for every number, ticker,
percentage and address.

Type scale (semibold 600 for headings, regular 400 for body):
  H7 24/36  H8 20/36  H9 16/24  H10 14/21  H11 12/18  H12 10/15
  Body1 16/24  Body2 14/21  Body3 12/18  Body4 10/15

Colours — violet is primary, rose is the second primary, imperial red is danger:
  violet-500 #703AE6 (primary)   violet-50 #F1EBFD   violet-100 #D3C2F7
  rose-500   #FF007A             imperial-500 #FC5457 (danger/negative)
  electric-blue-500 #32EEE2 (success)
  gray 50 #F4F4F4 · 100 #DFDFDF · 200 #BFBFBF · 400 #949494 · 600 #595959 · 900 #111111
  base white #FFFFFF · base dark #111111 · platinum #F7F7F7
  brand gradient: linear-gradient(135deg, #FC5457 10%, #703AE6 80%)

Text colours: headings #1F1F1F · paragraphs #4B5563 · placeholders #9CA3AF
Borders #E5E7EB. Radius scale: 4, 8, 12, 16, 20, 24, full.
Spacing scale (px): 2 4 8 12 16 20 24 32 40 48 56 64 72 80 120 — use only these.
Shadow: 0 7px 15px rgba(0,0,0,.08), 0 28px 28px rgba(0,0,0,.07)

MUST work in BOTH light and dark. Express every colour as a CSS custom property so the
card re-themes with the app. Use these names, which already exist:
  --cp-surface --cp-g50 --cp-g100 --cp-g200 --cp-g400 --cp-g500 --cp-g600 --cp-g900
  --cp-violet-500 --cp-violet-soft --cp-violet-soft-border --cp-gradient
  --cp-warn-fg --cp-danger-fg --cp-emerald --cp-amber
  --cp-venue-{margin|earn|farm|wallet}-{fg|bg|bd}

## 3. The data contract — this is fixed, design to it

interface AnswerFact { label: string; value: string; tone?: "neutral"|"good"|"warn"|"bad" }
interface StructuredAnswer {
  headline: string;                  // one sentence, leads with the figure asked for
  facts: AnswerFact[];               // 0 to ~16 items
  note?: string;                     // at most two sentences of context
  venue?: "earn"|"blend"|"aquarius"|"margin"|"wallet"|"oracle"|"none";
}

Facts are heterogeneous and you must handle the mix in ONE component:
  - FIGURES — short values that should align down a column: "13.97%", "$1,491.96", "2.89",
    "2,999.008863 XLM"
  - IDENTIFIERS — 56-character Stellar addresses (start G or C) and 64-char hex tx hashes.
    These must be shown IN FULL and be copyable.
  - LABELS vary in length: "HEALTH FACTOR" but also "OPTIONAL TRACKING TOKEN",
    "COLLATERAL LEFT BEFORE LIQUIDATION".

## 4. Real content it must render — design for the hardest of these, not the easiest

(a) 15 identifiers, the case that currently breaks:
  headline "Vanna Finance protocol contract addresses retrieved."
  REGISTRY = CBBQQULN3XZDWDZG7D6VYD4UQKBGYH22DOFQEISKENCMZTYUPQ5LDXUO
  ACCOUNT MANAGER = CAZLR6EHZXQNZJIFNP6F7SIJQC3P64MKHHQNZSSG5BNAEFCYTTGTDZXB
  RISK ENGINE, ORACLE, RATE MODEL, LENDING POOL XLM, LENDING POOL BLUSDC,
  XLM CONTRACT, USDC CONTRACT, OPTIONAL TRACKING TOKEN … (all the same length)
  note "Includes system contracts for risk management, price feeds, and lending pools."

(b) A 4-row comparison, each row with 5 numbers — currently a wall of text:
  headline "BLUSDC pays more for supplying: 13.97% vs 1.03% on XLM — 12.94 points apart."
  XLM     supply 1.03%  borrow 6.01%  used 17.18%  28,708.37 XLM supplied  23,676.55 available
  BLUSDC  supply 13.97% borrow 22.11% used 63.18%   5,124.83 BLUSDC        1,886.88
  AQUSDC  supply 8.20%  borrow 16.95% used 48.42%   3,595.93 AQUSDC        1,854.88
  SOUSDC  supply 0.07%  borrow 1.58%  used  4.51%  21,093.75 SOUSDC       20,141.76
  venue "earn"

(c) A risk answer where tone carries meaning:
  headline "Health factor 2.89 — healthy. Liquidates at 1.10; your floor is 1.30."
  HEALTH FACTOR 2.89 (good) · COLLATERAL $1,491.96 · DEBT $517.21 (warn)
  COLLATERAL LEFT BEFORE LIQUIDATION $1,220.27 · venue "margin"

(d) A projection — two states of one number:
  headline "After borrowing 10 BLUSDC ($10.00), your health factor would be about 3.14 —
  down from 3.19."

(e) A single headline figure, no facts at all:
  headline "XLM is trading at $0.1603." venue "oracle"

## 5. Three failures the current design has. Do not reproduce them.

1. Addresses were shortened to "CBBQQULN…5LDXUO". "Is this the right contract?" is the only
   question anyone asks of a protocol address, and a truncated one cannot answer it.
2. A 56-char value was forced through a `1fr auto` two-column grid. The value column
   stretched and the label column collapsed until "REGISTRY" wrapped one letter per line —
   "REG / IST / RY".
3. Sixteen facts rendered as sixteen identical rows with no grouping, so nothing was
   scannable and the answer had no visual hierarchy.

## 6. What "good" means here, in priority order

1. The answer is legible in one glance. The headline figure should be the first thing the
   eye lands on.
2. A 56-char address is fully readable and copyable without breaking the layout.
3. Sets of figures align so they can be compared down a column.
4. Tone (good/warn/bad) is visible without relying on colour alone — WCAG AA, 4.5:1.
5. It feels like part of the app, not a chat bubble. Calm, dense-but-not-cramped,
   financial-instrument precision.
6. Keyboard accessible, semantic HTML (dl/dt/dd where it is a description list), visible
   focus states.

## 7. Deliver

A single self-contained React component in an artifact:
  - props: `{ answer: StructuredAnswer }` — exactly the interface in §3
  - Tailwind utility classes where possible; inline `style` only for the CSS variables
  - no external dependencies except `lucide-react` icons
  - render ALL FIVE examples from §4 stacked, so I can judge it on the hard cases
  - include a light/dark toggle in the artifact so I can check both
  - no placeholder/lorem content — use the real strings above

Show your layout reasoning briefly before the code: how figures differ from identifiers,
and how you create hierarchy when there are sixteen facts.
```

---

## Wiring notes (for whoever integrates the result)

- Target file: `components/copilot/answer-view.tsx`. It already receives
  `{ answer: StructuredAnswer }`, so a component matching §3 drops in.
- Keep the identifier/figure split — it is load-bearing, not cosmetic (see §5.2).
- `FactsGrid` in `copilot-workspace.tsx` receives `shown` (the set of values the answer
  already rendered) and skips them. If the new design renders a fact the old one did not,
  it stops being duplicated below automatically.
- Do not introduce a hardcoded hex. Everything must go through `--cp-*` or it will not
  survive the dark theme.
- After wiring: `npx tsc --noEmit` and `npx vitest run` must stay clean, then check the
  card live at `/copilot` in both themes with prompt "show me the protocol contract
  addresses" (the 15-identifier case).
