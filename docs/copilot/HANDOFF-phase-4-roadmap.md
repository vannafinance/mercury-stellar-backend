# Handoff — Phase 4 and the remaining roadmap

**For:** the implementer (Grok 4.6). **Audited by:** Claude. **Created:** 10 Sep 2026.
**Branch:** `copilot-upgrade`.
**Baseline (verified):** `tsc --noEmit` clean · `npx vitest run` **1,585 / 0 / 3** · MCP pytest 61.

**Test account for every live check:** `CBOQAN5NFII4P5HD73M2IRSFYZSXC5XC76FQWQ5JU7LJAO66TFFPG5XY`
(wallet `GD4BQR…NPDH`, Stellar Testnet).

**Both repos in scope.** App: `vanna-copilot-orchestrator`. MCP: `C:\Users\akgam\Documents\vanna_mcp`.
**Never deploy contracts.** MCP and Sign Service deploys are authorised.

---

## 0. How to report back

```
**Done** / **Verified** / **Not done or deferred** / **Deviations** / **New findings**
**Suite:** tsc <…> · vitest <p>/<f>/<s> (baseline 1585/0/3) · pytest <…>
```

Name the repo per change. Report failures as failures. If a hypothesis here is wrong, say
which and what the real cause was.

---

## Deployment state — both blockers cleared, do not redo this

| Service | Revision | When | Note |
|---|---|---|---|
| `vanna-mcp-server` | `00089-wkn` | 10 Sep 11:30 | `liquidation_snapshot` live |
| `vanna-sign-service` | **`00047-qn8`** | **10 Sep 11:55** | **deployed — `GET /sessions` is now live** |
| `vanna-connect-gateway` | `00011-mwr` | 2 Sep | unchanged, no change needed |

Both of the blockers reported in Pass B were resolvable and are resolved:

- **The `node_modules` MAX_PATH crash** was not a missing ignore rule.
  `vanna-mcp/sign-service/.gcloudignore` already excluded `node_modules/` and
  `**/node_modules/`. The parent `vanna_mcp/cloudbuild.yaml` runs one directory above it, so
  the file never applied. Deploying with `--source .` **from inside `sign-service/`** picks it
  up and uploads fine. A root `.gcloudignore` was also added for the parent-build case.
- **The Cloud Build SA permission gap** is real; deploying as `aditya@vanna.finance` works,
  exactly as you did for MCP.

Rollback, if ever needed:
`gcloud run services update-traffic vanna-sign-service --to-revisions vanna-sign-service-00046-gmv=100 --region us-central1 --project vanna-mcp`

---

## Task 1 — Confirm the safety fix now completes, then test auto-approve

Your Task 3 change was correct: auto-approve refuses to arm unless `capsEnforced`. But
`capsEnforced` reads the session policy through `GET /sessions?walletAddress=…`, which did not
exist in the deployed Sign Service — so a correct safety fix had made auto-approve
**impossible to arm in production**. That is now unblocked.

1. Confirm `capsEnforced` resolves true on `CBOQAN…G5XY` and the card reads **"Budget active"**,
   not "Budget set — in-app only".
2. If it still reads in-app only, the cause is now app-side or policy-side, not a missing
   endpoint — say which.
3. Then run the acceptance prompt **five times with auto-approve ON**, and five with it **OFF**.
   Different code paths, different failure histories.

---

## Task 2 — Finish the planner cut

This is the phase that has not moved. Stated precisely so the target is unambiguous:

| File | Now | Target |
|---|---|---|
| `handle.ts` | **8,642** lines (unchanged from Phase 3 start) | ~2,000 |
| `router.ts` | **2,643** lines (up 28) | a read-through cache |

The first cut landed real work — `shouldUseLegacyExecutor` is gone and the shared read-cache
exists — but nothing has yet been *removed* from the decision paths. The remaining job:

- **`handle.ts` keeps only** approval replay, write execution, settlement verification and
  receipts. Everything that *decides* moves into the investigation loop.
- **Keyword write planning for the assistant widget** is the largest remaining decision path.
  It is still live and it is the thing to peel next.
- **`router.ts`** answers exact-match reads early and otherwise steps aside. It must not be
  able to override a researched plan.

**Move one decision path at a time, run the eval gate between moves.** You did this correctly
on the first cut — keep it. A single large deletion that fails the gate tells you nothing about
which move broke it.

**Keep untouched:** resume and multi-leg execution, the trust boundary, `usable-read.ts`
semantics, the binding rules, and Pass A's drift guard.

---

## Task 3 — MCP M2: split read surfaces from write surfaces

**The most important remaining safety work, and the gate on ever exposing MCP publicly.**

`vanna_margin_trade` dispatches `can_borrow` and `can_withdraw` *alongside* `deposit`,
`withdraw`, `borrow`, `repay` and `settle`, through one tool name.
`surface_tools.py` validates that an action exists and has its required arguments — it never
asks whether the action moves money.

So "the model may read but not write" is enforced **entirely in the app**, by `catalog.ts`
declaring read names and `LEGACY_TOOL_MAP` translating them. Not exploitable today: the server
is authenticated and our app is its only caller. But it nearly went wrong once — a catalogue
"alignment" would have pointed the model straight at the write dispatcher, and only your
decision to keep a read-only name prevented it.

- Split `vanna_margin_trade` into a read surface (`can_borrow`, `can_withdraw`) and a write
  surface. Same for `vanna_account`, whose `open`/`close` sit beside `list_inactive`.
- Scope them on the token, so a read-only caller is **never offered** a write tool rather than
  being trusted not to call one.
- Keep the old names dispatching for one release so the app migrates without a flag day.

---

## Task 4 — MCP M3: publish the surface, gate the catalogue on it

`catalog.ts` is a contract with the server maintained by reading Python in another repo, and
nothing fails at build time when the two drift. `vanna_auto_sign_status` was missing from
`LEGACY_TOOL_MAP` entirely and would have 404'd as an unknown tool — found by hand during a
live investigation, not by a test.

1. The server publishes tool names, actions and required arguments as machine-readable
   metadata. It already validates against this at call time.
2. CI fails if any `catalog.ts` capability does not resolve against it.
3. The check also runs against the deployed server on a schedule, so a server change that
   breaks the app is caught by us rather than by a user.

---

## Task 5 — Latency, with honest numbers

`logPhase` exists but has never been read against a real signed-in turn. Capture the breakdown
for a strategy turn on `CBOQAN…G5XY` and **name the dominant cost** before optimising anything.

Targets: strategy proposal < 15s, account question < 5s.

Levers not yet applied, from blueprint §9: pre-seed the reads always needed (fire prices
concurrently with the first model call), and a server-side position cache keyed by
`(smartAccount, ledger)` — never a client-supplied number. The 5-minute scope cache landed in
2.7; confirm it is actually hitting.

If the time turns out to be dominated by something these do not touch, say so and stop. That
finding is worth more than a speculative optimisation.

---

## Deferred, pending an owner decision

**The dual-line collateral display.** Settled against contract source
(`Protocol_V1_Soroban` branch `testnet` @ `1d333fb`): `get_current_total_balance_internal`
walks only `get_all_collateral_tokens()` — posted collateral. The app adds unposted SAC held by
the same margin account. On `CBOQAN…G5XY` at ledger 4603116 that is app $1,087.20 / HF 3.90 vs
contract $953.80 / HF **3.42**.

The recommendation in `docs/copilot/OWNER-collateral-definition.md` stands: show posted,
unposted, and compute health from posted. Do **not** change the app maths until the owner
decides — it is load-bearing for Margin and Portfolio.

---

## Order

1. Task 1 — cheap, unblocks the owner's own testing, confirms the deploy did its job.
2. Task 2 — the planner cut. The largest remaining app work.
3. Task 3 — MCP M2. Do before any public-exposure discussion.
4. Tasks 4 and 5 — parity gate and latency, in either order.

M4 (custom per-user spend limits under the $1,000/day ceiling) and M5 (per-tool timing, shared
price cache) follow once these land.

> **Superseded by `HANDOFF-roadmap-v2.md`** (10 Sep 2026). Every task here still appears there, plus four items from a production-practice review, in a corrected order. Use v2.
