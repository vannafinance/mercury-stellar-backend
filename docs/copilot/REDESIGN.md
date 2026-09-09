# Copilot surface — redesign log

Living document. Update it whenever the copilot surface is redesigned, or when a redesign
is proposed and rejected. Record the *reason*, not just the change — most of the cost in
this area has come from re-litigating decisions whose evidence was never written down.

Last updated: 2026-09-08.

---

## 1. Locked design direction

The copilot surface is **Rail** — Ledger's geometry with Rail's 3px left accent. This was
settled by the owner on 2026-08-12 and should not be reverted to plain Ledger.

Source of truth was Claude Design project `d3918366-4a48-4bca-916a-a95b78a846bc`
(`Copilot.dc.html` = Ledger, `Copilot Rail.dc.html`, `Copilot Editorial.dc.html`).

**The three design files were one design, not three.** Byte-level diff: identical logic
block in all three (65,396 chars); CSS identical between Ledger and Rail; all 53 markup
divergences per pair were only `border-radius`, `padding`, `box-shadow` or `border-left`.
Do not re-compare them by eye — normalising those four properties makes them match.

> ⚠️ `docs/copilot/DESIGN-PROMPT-copilot-surface.md` and `docs/copilot/TOKEN-MAP-cards.md`
> are referenced by older notes but **no longer exist in this repo**. The decisions they
> recorded are summarised here instead. Do not go looking for them.

### Card geometry

| | Border | Left accent | Radius | Padding |
|---|---|---|---|---|
| Main-column card | `1px var(--cp-violet-soft-border)` | `3px var(--cp-violet-500)` | `11px` | left is **3px short of right** |
| Rail card | `1px var(--cp-g100)` | `3px var(--cp-g300)` | `11px` | left is **3px short of right** |

The accent marks **main column vs rail**, not venue. Measured: of five accented cards,
"Your intent" contains 0 venues, "Open positions" 3 at once, Autonomy and Recent-on-chain
0 — so it cannot be venue-coded. The short left padding is deliberate, so text still lines
up over the thicker border.

### Rejected grafts, with the reason

- **Editorial's card shadow** — rejected. `--shadow-card` is the only token in any of the
  three files that `app/globals.css` does not define, and the app is hairline-bordered
  throughout.
- **Editorial's warm page** — rejected. `--page` is site-wide; changing it would make
  `/copilot` a different colour from Earn/Margin/Farm.
- **Editorial's radii (13/17/19/25)** — rejected. They appear nowhere in the app. The
  app's own usage is 8px×53, 12px×32, 16px×25, 10px×22, 20px×16, which Ledger's 8/12/14/20
  matches.

### Do not point the card tokens at the brand ramp

The two transaction cards share one `--card-*` layer, with all 75 `--pc-*`/`--rc-*` names
surviving as aliases declared once. Merging them into the page brand ramp was measured and
**costs contrast on the two safety-critical cards**: earn ink 8.8:1 → 5.3:1, danger
9.3 → 5.2, margin 11.3 → 7.0. None of the 75 card tokens equals a page token in both
themes, and venue/status colours are ΔE 13–30 apart. The cards' ramp was contrast-measured
against an opaque card surface; the page ramp is translucent over the page.

### Things that look like restyle targets and are not

- `components/copilot/auto-approve-toggle.tsx` renders **outside** `.cp-root` and
  deliberately matches the navbar Dark Mode row (`navbar.tsx`).
- `components/copilot/assistant-region-overlay.tsx` is theme-independent by design (a
  `#111` pill on a `bg-black/35` scrim). Tokenising it paints white on white in dark.
- The **session log must stay its own card**. The design nests it inside the prompt-palette
  card; the shipped UI keeps it separate and that is the owner's explicit deviation.

### Token contract

`.cp-root` scopes the copilot palette so it cannot collide app-wide, and aliases
`--color-vgray-*` onto Ledger's `--g*`, which moves all 301 Tailwind colour utilities on
the shell with no markup change. Status palette: `--cp-ok-*`, `--cp-warn-*`,
`--cp-danger-*` (each `-fg`/`-bg`/`-bd`). Never persist a resolved colour — store a
semantic tone and resolve at render, or old rows freeze an old palette.

---

## 2. Current surface state (2026-09-08)

One composer, one **Run**. There is no mode selector: which engine handles a turn is a
server decision (`POST /api/copilot/dispatch`), never something the user picks.

Removed this session, with reasons worth keeping:

- **Investigate / Actions toggle** — a person asking for a strategy should not have to know
  that research and execution are different code paths, and the toggle made
  "deposit 5 XLM as collateral" silently non-executable.
- **`vertex · mcp live · 14 tools` chip** — build detail the user cannot act on, and its
  "brain offline" state fired on any transient health fetch (a dev-server recompile, a cold
  start), which reads as a broken product. Real failures surface on the turn card.
- **"Read only" badge** on the investigation card.
- **Rail account rows** (wallet, smart acct, collateral, debt, net value) — collateral and
  debt duplicated the dial's own figures directly above them; the addresses are not
  actionable.
- **Rail signing rows** (signing, guardian, signer, enforcement, custody) — static or
  duplicating the Auto-approve control above. `sign service` / `signing authority` were
  **kept but only render when they report a problem**: a row that exists to say "everything
  is fine" is the clutter, while the same row saying "not bound" is what stops a 403 being
  misread as a wallet-connection problem.

Investigation card order: message → **What I understood** (objective, the user's own
constraints as chips, borrowing stance) → position → wallet → borrowed → live rates →
borrowing economics → needs-your-decision → warnings → collapsed **Evidence**.

Values are rendered at human precision (USD 2dp, rates 2dp, HF 2dp, tokens ≤4dp); the exact
28-decimal strings stay under Evidence, so nothing is hidden, only re-rendered.

---

## 3. Open redesign items

1. **Whole-page redesign** — requested by the owner 2026-09-08, not yet scoped. Must keep
   §1 constraints unless the owner explicitly relaxes them.
2. **The dial's liquidation label.** It reads "liquidates at 1.10", but the deployed
   RiskEngine returns *unhealthy* at exactly `1.100000` and healthy only from `1.100001`
   (binary-searched to 1e-6). At 1.10 the account is already liquidatable, so the label
   reads safer than reality. Needs a strict-boundary wording.
3. **Which collateral figure the page shows.** Four numbers are in circulation — UI store,
   MCP `account_health`, MCP `account_collateral`, and the contract. Live spot check:
   app `2858.90` vs contract `3201.70`. Whatever the redesign displays should be the
   contract's, or be labelled as something else.
4. **Findings prose is deliberately unpublished.** `understanding` and `rateComparisons`
   are safe to feature (a restatement of the user's own request, and APR-vs-APR
   arithmetic). Model findings prose stays an internal draft until Phase 3 validates
   financial claims — do not promote it in a redesign.
5. **Progress events must stay real.** Never show a cosmetic "thinking" sequence that did
   not occur; the labels come from actual read/decision events.
6. **The Options block is the piece most worth redesigning.** It is the only part of the
   card where the user makes a decision, and it currently renders as a flat stack of
   bordered rows with the leader distinguished only by border colour. Ranked, comparable
   choices with a size, a rate and a risk consequence each want a comparison layout, not a
   list. Constraints: the ruled-out shapes and their reasons must remain visible (hiding
   them makes "no option" read as "nothing considered"), and every number must keep its
   qualifier — a size without the health factor it produces is the number that gets
   approved without being understood.

---

## 4. A redesign will not require rebuilding the agent

Recorded because the owner has said the UI may change again ("later on i may want to change
the UI so it shows responses in a much better way", 2026-09-09).

The response data and its presentation are already separate, and deliberately so:

- `ResearchView` (`lib/copilot/investigation/view.ts`) is the whole contract — a plain,
  browser-safe object with no actions, signatures, raw MCP payloads or credentials in it.
  Everything the surface can show is a field on it.
- `capacity`, `candidates` and `rateComparisons` are **computed values, not prose**, so a
  new layout re-arranges them without re-deriving anything and without asking the model
  again. `investigation-card.tsx` holds only formatting decisions (precision, ordering,
  emphasis); no financial logic lives in the component.
- Consequently a redesign touches `investigation-card.tsx` and
  `tests/components/investigation-card-options.test.tsx`, and nothing under `lib/`.

The reverse is what to avoid: moving a calculation into a component to make a layout
convenient. `sizing.ts` owns every amount and `candidates.ts` owns every ranking precisely
so a visual change cannot alter a number.

---

## 5. Changelog

- **2026-09-08** — Collapsed to one composer (Prompts + Run); removed the mode toggle,
  status chip, read-only badge and the two rail meta blocks; rebuilt the investigation card
  around "What I understood"; added human-precision value rendering. Recorded the missing
  design docs and the 1.10 boundary finding.
- **2026-09-09** — Wired the ranked Options block and covered its rendering with
  `tests/components/investigation-card-options.test.tsx` (sizes, net carry, resulting health
  factor, DOM ranking, ruled-out reason, and no borrow shape under "do not borrow"). Fixed
  the surface's worst remaining number lie: an amount the user named outright was being
  re-sized to the floor, so "borrow 500 USDC" rendered as a $6,541 proposal. Recorded the
  Options block as the highest-value redesign target and why a redesign stays confined to
  the component.
