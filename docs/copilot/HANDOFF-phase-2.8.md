# Handoff — Phase 2.8: stop discarding data we already fetched

**For:** the implementer (Grok 4.6). **Audited by:** Claude. **Created:** 10 Sep 2026.
**Branch:** `copilot-upgrade`.
**Baseline (verified, not taken on trust):** `tsc --noEmit` **clean** · `npx vitest run` = **1,547 passed / 0 failed / 3 skipped**.

Companion: the architecture blueprint — §7 binding rules, §9 latency and cost, §12 invariants.

---

## 0. How to report back — same format, every time

```
## Summary

**Done**
- <file:line> — what changed, in one line

**Verified**
- <command run> → <actual result, not "passed">
- <live prompt tested> → <what the UI actually returned>

**Not done / deferred**
- <task> — why, and what it is blocked on

**Deviations from the handoff**
- <what I did differently> — why I judged it better

**New findings / questions**
- <anything the handoff did not anticipate>

**Suite:** tsc <clean|N errors> · vitest <passed>/<failed>/<skipped> (baseline 1547/0/3)
```

Report failures as failures, with output. **If a hypothesis here is wrong, say which and
what the real cause was** — that is what turned Phase 2.7 into a correct diagnosis after
both of my Phase 2.5 hypotheses missed.

---

## What Phase 2.7 achieved — and what the live run then showed

2.7 was good work. `lib/usable-read.ts` landed as the shared helper, the borrow scan now
fails closed instead of dropping a leg, bindings no longer accuse the user, and the eval
harness is a hard CI gate. Suite 1,525 → 1,547.

**The read gate is now open.** The flagship prompt reaches the account: the live run
reported health factor 3.90 and margin debt $278.86, and the account panel rendered
4 supplied / 3 borrowed. That was the blocker across four phases.

**But the answer was mostly warnings**, and the run surfaced three new defects:

```
Your reported health factor is 3.898658825216954744. Your reported margin debt is $278.86.
  ! can withdraw:        data was unavailable. No value was assumed.
  ! account collateral:  no supported display fields were available.
  ! account debt:        data was unavailable. No value was assumed.
  ! account health:      data was unavailable. No value was assumed.
  ! account health:      no supported display fields were available.
                                                        [ Worked for 28m 45s ]
```

Note also: the figures that *did* appear (3.90, $278.86) came from the **pre-seeded app
snapshot**, not from any MCP read. The authoritative path works; the MCP read path does not.

---

## Task 1 — The normalizer discards reads that succeeded

**The most important task. This is the difference between an answer and a shrug.**

Those five warnings are two different failures, and only one is a read failure:

| Warning | Emitted at | Meaning |
|---|---|---|
| *"data was unavailable. No value was assumed."* | `normalize.ts:16` | `status !== "ok"` — the read genuinely failed |
| *"no supported display fields were available."* | `normalize.ts:171` | The read **succeeded**, `data` is present, and the normalizer extracted **zero facts** |

The second is a bug on our side: MCP returned the numbers and we threw them away.

**Confirmed field mismatch.** `normalize.ts:58-63` reads `account_health` as:

```ts
add("health_factor", ..., data.health_factor, "HF", "margin");
add("collateral_usd", ..., data.collateral_usd, "USD", "margin");
add("debt_usd",       ..., data.debt_usd,       "USD", "margin");
add("ltv_ratio",      ..., data.ltv_ratio,      "ratio", "margin");
```

The MCP tool returns `is_healthy`, `distance_to_liquidation`,
`net_available_collateral_usd`, `net_borrow_rate_pct`, `collateral_usd`, `debt_usd`,
`ltv_ratio` — and **no `health_factor` key at all**. `README.md` already recorded this
symptom: *"MCP's `account_health` returned debt positions but no scalar ratio, so the card
said 'account health: data was unavailable' beside a rail showing 2.43."*

**Do this, in order:**

1. **Log the raw payload** for any observation that produces zero facts — capability,
   status, and the top-level keys of `data`. Do not guess the shapes from the Python
   source; read what actually arrives. (Keys only, not values — the payload can be large
   and `sanitizeData` already redacts secrets.)
2. **Map the real fields** for at least `account_health`, `account_collateral`,
   `account_debt` and `can_withdraw`. Add the ones MCP genuinely returns —
   `is_healthy`, `distance_to_liquidation`, `net_available_collateral_usd`,
   `net_borrow_rate_pct` are all useful facts we currently drop on the floor.
3. **Keep the existing keys** as alternatives rather than replacing them. A tool may return
   either shape across versions, and silently supporting only the new one recreates this
   bug in reverse.
4. **Do not synthesise a health factor** from MCP's collateral and debt. The comment at
   `normalize.ts:63` is right — contract and UI semantics differ, and the authoritative HF
   already comes from the seeded snapshot.
5. **Make "zero facts from a successful read" loud in tests.** Add a normalizer test per
   capability asserting at least one fact from a realistic payload, so a future shape drift
   fails CI instead of reaching a user as a warning.

**Separately**, three reads genuinely failed (`can_withdraw`, `account_debt`, one
`account_health`). The logging from step 1 should say why — a 401, a timeout, or a tool-name
mismatch are all live candidates. `can_withdraw` is the flagship prompt's own read, so it
matters most.

---

## Task 2 — The elapsed timer is lying, and it has been misleading every latency reading

`copilot-workspace.tsx:4469` sets `startedAt = Date.now()` inside an effect and ticks every
second, but never resets per run. The card therefore shows **time since mount**, not time
for this investigation.

The "28m 45s" is impossible as a server duration: `maxDurationMs` is 45s and the route caps
at `maxDuration = 300`. So the real run was at most five minutes and probably well under one.

**Why this is worth fixing before any latency work:** every timing number we have taken from
this UI is unreliable, including the "1m 09s" that motivated the §9 latency plan. We cannot
tune what we cannot measure.

- Reset `startedAt` when a run begins, not on mount.
- Stop the clock when the run resolves, so a finished card shows the run's real duration.
- Report the **server-measured** duration alongside it where the SSE stream can carry it —
  the client clock includes network and render time the server budget does not control.

---

## Task 3 — Health factor printed to 18 decimal places

`answer.ts:16`:

```ts
if (health) sentences.push(`Your reported health factor is ${health.value}.`);
```

`health.value` is the raw fact string, so the user reads
`3.898658825216954744`. The very next line formats debt correctly as `$278.86` via
`amount(debt)` — so the inconsistency is in this one call.

Round health factors to **2 decimals** for display. Keep full precision internally: sizing
must stay exact, and only the presentation is wrong. Check the other raw `.value`
interpolations in `answer.ts` for the same leak while you are there.

---

## Task 4 — Then, and only then, the latency levers

Once Task 2 gives honest numbers, take the cheap wins from blueprint §9:

- **Cache scope per session (5 min).** Two chained MCP calls run on every turn.
- **Pre-seed the reads always needed.** Fire prices concurrently with the first model call.
- **Server-side position cache** keyed by `(smartAccount, ledger)` — never a client-supplied
  number.

Measure before and after with the fixed timer and record both in your summary. If the
numbers turn out to be fine after Task 2, say so and skip this — do not optimise a problem
we cannot demonstrate.

---

## What NOT to change

- **Sizing, and the source of truth.** Still Phase 3, still pending the ledger-pinned
  `liquidation_snapshot` measurement.
- **The trust boundary.** No writes in the catalog; identity bound from `scope`;
  `validateModelArgs` exact key-set match.
- **`lib/usable-read.ts` semantics.** A failed read stays unavailable-with-reason. Task 1
  fixes reads that *succeeded*; it must not soften the failure path.
- **The binding rules** (blueprint §7): reads need no binding, manual writes need no
  binding, auto-sign does. Settled.
- **`router.ts` / `handle.ts` size.** Phase 3.

---

## Acceptance

1. No warning of the form *"no supported display fields were available"* for
   `account_health`, `account_collateral`, `account_debt` or `can_withdraw` on a live run.
2. `can I withdraw 100 XLM without getting liquidated?` returns a real answer citing the
   `can_withdraw` read — **five runs on the signed-in UI**, since the failure was intermittent.
3. Health factor renders as `3.90`, not `3.898658825216954744`.
4. The elapsed clock shows this run's duration and stops when it finishes.
5. A normalizer test per capability fails if a payload yields zero facts.
6. `tsc --noEmit` clean; suite no worse than 1,547 / 0 / 3.

---

## Environment note — auto-sign is now testable

`SIGN_CONNECT_BASE_URL=https://vanna-connect-gateway-uscm2gn35a-uc.a.run.app` is set, and
auto-approve toggles on. For reference, the three services in the `vanna-mcp` project:

| Service | Serves | Auth |
|---|---|---|
| `vanna-mcp-server` (`mcp.vanna.finance`) | MCP tools | 401 — reachable |
| `vanna-connect-gateway` | `/connect`, the consent page (embeds a Privy signer id) | 200 — public |
| `vanna-sign-service` | signing + auto-sign policy and caps | 403 — IAM-gated |

The Sign Service is Vanna's own service, not Privy; Privy is the signer embedded in the
gateway's consent page.

---

## Then

**Phase 3 — one planner.** `router.ts` becomes a read-through cache with no authority to
override a researched plan; `handle.ts` reduces to approval replay, execution, settlement
verification and receipts. The P2.6 eval gate now exists, so the regression net is in place
before the cut. The MCP-side blueprint is due for discussion at the same point.
