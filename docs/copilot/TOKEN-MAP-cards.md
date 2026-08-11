# Card token map — `--pc-*` / `--rc-*` vs the shared palette

Written 2026-08-11, step 1 of the Ledger restyle. The question this answers: the plan
approval card and the run execution card each carried their own light and dark token
block — four blocks, 150 declarations, 75 names — while the rest of the copilot surface
runs on one shared palette in `.cp-root`. Can the cards be aliased onto it?

**Answer: onto the page palette, no. Onto each other, yes, at zero cost — and that is what
shipped.** Everything below is measured from the values in `app/globals.css`, not eyeballed.

## What shipped

One canonical `--card-*` layer declared on `.plan-card, .run-card` (44 names, light + dark),
with all 75 `--pc-*` / `--rc-*` names kept verbatim as aliases onto it, declared once and
never repeated per theme. Four token blocks became two.

Verified: all 75 tokens × 2 themes = 150 resolutions compared against the previous
commit — byte-identical. No pixel changed, no markup touched.

Every name had to survive verbatim because both components build some at runtime:

```tsx
function venueTokens(venue: PlanVenue) {
  const key = venue === "other" ? "wallet" : venue;
  return { fg: `var(--pc-${key}-fg)`, bg: `var(--pc-${key}-bg)`, bd: `var(--pc-${key}-bd)` };
}
```

A static search calls those 23 venue tokens dead. They are not — the lookup is computed.

## Why the two cards share a block

Their design files agree. Of the **32 roles both declare, 30 are byte-identical in both
themes.** The two exceptions were nobody's decision — they surfaced only by diffing:

| role | light (plan) | light (run) | ΔE | contrast on `#ffffff` | dark |
|---|---|---|---|---|---|
| `quiet` | `#5a6472` | `#56606e` | 1.64 | 6.00:1 vs 6.38:1 | identical `#a2a9b8` |
| `accent` | `#5b23d6` | `#4b1bc4` | 6.36 | 7.91:1 vs 9.32:1 | identical `#c0a5ff` |

`accent` at ΔE 6.4 is a visibly different violet, so neither was silently picked. Both are
held apart as `--card-accent` / `--card-accent-run` and `--card-quiet` / `--card-quiet-run`
so this commit changed nothing. **Open decision for the restyle: which value wins.** The run
card's is the higher-contrast one in both cases.

## Why not onto the page palette

Of the **75 card tokens, zero** hold the same value as a page token in both themes. Only one
role — the white button label — is even perceptually indistinguishable. Grouped by how close
the nearest page token gets in its *worse* theme:

| ΔE (worse theme) | count | roles |
|---|---|---|
| < 1 indistinguishable | 2 | `btn-fg` (both cards) |
| 1–3 just-noticeable | 11 | `inset`, `line`, `line-soft`, `body`, `wallet-bg`, `rc-track` |
| 3–6 visible | 16 | `surface`, `heading`, `muted`, `wallet-fg`, `wallet-bd`, `btn-2-fg`, `rc-focus-bg`, `rc-field-bg` |
| 6–12 clearly different | 32 | `accent`, `accent-soft`, all venue/status **backgrounds and borders**, `btn-2-bd`, `btn-off-bg`, `rc-field-bd` |
| > 12 different colour | 12 | all venue/status **inks**: `margin-fg`, `earn-fg`, `farm-fg`, `warn-fg`, `danger-fg`, `rc-ok-fg`, `rc-ok-bd` |
| not a plain colour | 2 | `btn-fill` (gradient — differs in both stops and end colour) |

The greys are genuinely close. The venue and status colours are a different palette, not a
variant of one, and the reason is structural: the card ramp was contrast-measured against a
**card** surface and is opaque (`#ede6fd`), where the page ramp is translucent over the
**page** (`rgba(112,58,230,.10)`). Comparisons above composite the translucent page tokens
over the card surface first, which is what the eye actually sees.

### What a merge would cost, in contrast on the card surface

| ink | today (light) | if aliased to the page token | page token |
|---|---|---|---|
| `earn-fg` | 8.8:1 | **5.3:1** | `--venue-earn-fg` |
| `farm-fg` / `warn-fg` | 9.2:1 | **5.9:1** | `--venue-farm-fg` |
| `danger-fg` | 9.3:1 | **5.2:1** | `--danger-fg` |
| `margin-fg` | 11.3:1 | **7.0:1** | `--violet-600` |
| `rc-ok-fg` | 8.0:1 | **5.3:1** | `--venue-earn-fg` |
| `accent` | 7.9:1 | **6.1:1** | `--violet-500` |
| `quiet` (plan) | 6.0:1 | **4.8:1** | `--g400` |

All still clear AA, none below 4.5:1 — so this is a legibility trade, not a break. But these
two cards are the approval gate and the live run for transactions that move real money, and
they are the surfaces where a misread costs the most. They keep the higher-contrast ramp.

The greys move the other way and would mostly *improve* (`muted` 9.0 → 10.3, `body`
14.0 → 14.7), which is why the grey ramp is the one part of this worth revisiting if the
owner wants fewer palettes.

## Correction to a claim in the old comment

The design files quoted their own contrast as body 12.4:1 light / muted 8.6:1. Recomputed
from the actual hex values with the WCAG formula: **body 14.0:1, muted 9.0:1** in light,
**14.8:1 / 9.8:1** in dark. The design's figures were pessimistic; the CSS comment now
carries the measured ones.

## Resolved: the status ink / mark split

The owner's call on 2026-08-12 was "fix it and consistent everywhere". Fixed, and the fix
was larger than the emerald it started from — **all three** bright status hues fail WCAG AA
as text on a white card:

| used as text | light on `#ffffff` | dark on `#1c1c24` |
|---|---|---|
| `--emerald` `#10b981` | **2.54:1 fail** | 7.48:1 |
| `--amber` `#f59e0b` | **2.15:1 fail** | 7.58:1 |
| `--imperial-500` `#fc5457` | **3.21:1 fail** | 5.27:1 |
| `--violet-500` `#703ae6` | 6.11:1 | 4.87:1 |

The palette already had AA-safe inks for two of the three (`--warn-fg` 5.92:1, `--danger-fg`
5.22:1) and was missing only `ok`. So `--ok-fg/-bg/-bd` now completes the trio, with the
same shape as its siblings: a readable ink, a ~10% fill, a ~30% border. `--ok-fg` is
`#0b7a63` (5.28:1) in light and `#3fc0a3` in dark.

The workspace's four colour constants were renamed to what they now are — `OK_INK`,
`WARN_INK`, `BAD_INK`, `ACCENT` — and point at those inks. **No separate mark colour was
needed**, which is the part worth remembering: each ink is dark in light mode and bright in
dark mode, so a 5px dot and a gauge fill want exactly the same value. On white the darker
ink is *more* visible than the bright hue; on a dark panel the ink already resolves to the
bright hue. One value per status, right in both themes and in both roles.

Also fixed while wiring this: two call sites built a chip fill as `` `${color}18` `` —
appending an alpha byte to a 6-digit hex. That silently produced no background once the
constants became `var()`, since `var(--cp-ok-fg)18` is not a colour. An interpolated token
cannot carry alpha, so the fills come from `statusTint()` and the `-bg` tokens now. Six
further `rgba()` literals of the light-mode hues (risk chips, the all-settled card border
and header wash) became tokens, so a settled strategy is no longer outlined in light-mode
green on a dark panel.

## Still open

Which value wins where the two card designs disagree — `accent` (#5b23d6 vs #4b1bc4,
ΔE 6.36) and `quiet` (#5a6472 vs #56606e, ΔE 1.64). Both are held apart as `--card-*` and
`--card-*-run`, so nothing is broken; converging them is a one-line change once someone
looks at the two cards side by side. The run card holds the higher-contrast value in both.

## The invariant this buys

The failure this surface kept hitting was a token declared in one theme block and forgotten
in the other — it resolves to nothing and paints a transparent background, or inherits an
ancestor's colour. `--cp-*` was restructured to make that impossible; the cards were the
remaining exception, and with 75 names across four blocks they were the largest one. An
alias cannot be forgotten in one theme because it is not declared per theme at all.

The second, quieter failure it closes: two hand-maintained copies of the same palette drift.
They already had — twice.
