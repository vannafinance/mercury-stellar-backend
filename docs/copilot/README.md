# Vanna Copilot — how it works

Reference for the agent-native copilot: what it is, the path a message takes, which model
does what, and where each safety property lives.

Companion docs:
- [ARCHITECTURE.md](./ARCHITECTURE.md) — the same system as diagrams: services, message
  path, write and plan lifecycles, identity, multi-leg execution.
- [GUARDRAILS.md](./GUARDRAILS.md) — every refusal and safety gate, which file owns it, and
  the failure that motivated it.
- [ONBOARDING.md](./ONBOARDING.md) — pick this up and run it in ~15 minutes.
- [OPEN-ISSUES.md](./OPEN-ISSUES.md) — what is still broken, and whose call each one is.
- [NEXT-SESSION.md](./NEXT-SESSION.md) — live regression prompts, measured latency, traps.

> `docs/ONBOARDING_COPILOT.md` and `docs/copilot-integration-plan.md` describe a FastAPI
> Python orchestrator that **no longer exists**. Both now carry a banner; do not onboard
> from them.

---

## 1. What it is

A natural-language interface to the Vanna protocol on Stellar/Soroban. The user states an
intent — "deposit 10 BLUSDC, borrow 5, then supply that to Blend" — and the copilot
decomposes it, prices it, shows it for approval, executes it leg by leg, and reports what
actually landed on chain.

The product framing (from *Vanna x AI Agents*, idea #1) is an **agent-native margin
copilot**: collateral selection, borrow sizing, venue routing, execution, monitoring and
risk controls behind stated guardrails — max leverage, minimum health factor, allowed
assets, approval thresholds.

**The load-bearing design rule:** the LLM only ever interprets *language*. It never decides
what is safe, never invents a number, and never chooses whether something executes.
Deterministic code owns amounts, assets, ordering and refusals; MCP and the Sign Service own
risk and spend policy. Every time this rule has been bent, the bug that followed looked like
"the model said something plausible and wrong".

## 2. Surfaces

| Surface | Where | What it answers |
|---|---|---|
| **Copilot workspace** | `/copilot` — `components/copilot/copilot-workspace.tsx` | The full agent: intent → plan → approve → execute → receipt |
| **Page assistant** | "Ask about this page" on any page — `lib/copilot/concept.ts`, `page-agent.ts` | Explains the screen and Vanna concepts. No MCP access, no writes |
| **HTTP API** | `POST /api/copilot` — `app/api/copilot/route.ts` | Same brain, no UI. What the test harnesses drive |

The split matters: the page assistant has **no** live account access. Sending an account
question there produces "I do not have access to your live positions" while the copilot sits
behind it holding the numbers — historically the single most common wrong answer on this
surface. `isAssistantChat()` is the gate, and it defaults to routing to the copilot.

## 3. Models

| Call | Model | Thinking | Why |
|---|---|---|---|
| Intent routing (`route:fc`) | `gemini-3.6-flash` via Vertex, function-calling | **default (on)** | Picks the tool/op. A wrong choice here is a wrong *action* |
| Strategy planning (`llm-planner`) | same | default | Decomposes free-form multi-leg prompts |
| Answer formatting (`answer`, `explain`) | same | **low** (`thinkingLevel: "low"`) | Only formats figures MCP already returned |
| Execution receipt (`receipt`) | same | default | Narrates what settled |
| Page assistant / guide | same | default | Grounded in page DOM |

Model id: `VERTEX_MODEL`, default `gemini-3.6-flash`, project `vanna-mcp`, `location=global`.
Fallbacks: `gemini-2.5-flash,gemini-2.0-flash-001,gemini-2.0-flash`.

**Why thinking is tuned per call, not globally.** Gemini 3.x thinks by default. Measured on
the answer-formatting call: `output=48 thoughts=515` — eleven times as many tokens deciding
how to phrase "XLM is $0.1642" as saying it, ~3s of a 4.6s turn. Thinking bills at output
rates, so it is both the latency and the cost driver. It is turned down **only** where there
is nothing to reason about (`lowThinkingConfig` in `vertex.ts`), and left on wherever the
model is making a decision. Warm read latency roughly halved: price 4.6s → ~2.2s, pool
stats 7.0s → 2.7s.

Auth is server-side only — no end user ever authenticates with Google. Order:
Workload Identity Federation → service-account key → ADC → `gcloud`. The last two are
per-developer credentials and are last on purpose: when a `gcloud auth login` lapses,
routing throws and understanding silently degrades to keyword matching, which is why the
same prompt used to answer on one laptop and not another. `vertexAuthMode()` surfaces which
one is in use in the health chip.

## 4. The path a message takes

`lib/copilot/handle.ts` → `handleChat()`, roughly in order:

1. **Structured client actions first** — `summarize_execution`, then `approved_plan`. An
   approved plan is replayed **verbatim and never re-inferred**; running the model again
   could produce a different plan than the one the user saw.
2. **Domain firewall** (`domain-firewall.ts`) — blocks off-domain use before spending a
   token. Allowlist is product vocabulary; every inflection is spelled out because
   `position\b` does not match "positions".
3. **Auto-sign control** — NL and button forms of enable/disable/caps.
4. **Resume paths** — `pending_write`, `resume_multi_leg`. A resume never falls through to
   re-routing the original prompt: that would re-execute legs already settled on chain.
5. **Page-assistant gate** — `isAssistantChat()`.
6. **Routing** — keyword router (`router.ts`) first. If it is confident, Vertex is skipped
   entirely. Otherwise `vertexSelectTool`, then deterministic corrections re-apply on top
   (venue, USDC variant, unsupported asset).
7. **Plan extraction** — `step-extractor.ts` decomposes clauses into ordered legs;
   `plan-sanitize.ts` and `residue.ts` check that every part of the message was accounted
   for.
8. **Automation-gap guard** (`conditional-guard.ts`) — refuses conditionals and standing
   orders rather than acting on a condition it has not read.
9. **Plan → preview → approve → execute**, or a single write, or a read.

### Reads

`runRead()`. Position questions (`health`, `collateral`, `debt`) are answered from
`computeMarginSnapshot` — the **same on-chain read the Margin page renders** — not from MCP.
This is an override, not a fallback: the two disagreed ($214.72 vs $382.87 of collateral,
HF 1.95 vs 3.47) because MCP reports only the recorded balance while the site also
reconciles raw SAC holdings. Two different answers to "am I about to be liquidated" is the
worst failure this surface has.

A named asset narrows the answer (`positionAssetFocus`), and farm tracking positions
(`BLEND_XLM`, `AQ_XLM_USDC`) are reported separately using the site's own
`isTrackingSymbol` — one rule, so the two surfaces cannot disagree about one account.

### Writes

`runWrite()`. Order is deliberate: **validation before wallet**. Negative amounts, zero,
and over-cap leverage are refused before anything asks the user to connect — otherwise
every malformed request came back as "Connect your wallet", hiding the real problem.

Ops that cannot be atomic are split, with the protocol reason recorded next to the rule in
`registry/workflows.ts`:
- `deposit_and_borrow` → deposit, then borrow. MCP's combined call runs `is_borrow_allowed`
  against collateral *before* the deposit leg of the same call is credited.
- levered Blend farm → deposit → borrow → supply(net of origination fee). Atomic deploy hits
  the Soroban budget limit on populated pools.

### Plans

`freezePlan()` produces the approval card: per-leg labels, venue badges, a **signature
count** (legs, not steps — a levered step signs more than once), warnings, and a `plan_id`
that is a **fingerprint of every executable slot**. `verifyApprovedPlan()` rejects rather
than repairs: a plan whose slots changed after approval fails the hash. That hole is how an
approved "deposit 500 AQUSDC, borrow XLM at 3×" once executed as `borrow 1000 AQUSDC`.

Plans may contain **read legs** ("…then tell me my health factor"). They are shown as
"no signature" rows, excluded from the signature count, included in the fingerprint, and
executed **after** the writes settle — a report on pre-action state answers the wrong
question.

## 5. Execution and signing

Two independent things, never conflated:

- **`Authorization: Bearer`** — the app's WorkOS M2M token. *Which application is calling.*
  Sent on every call.
- **`X-Vanna-User-Assertion`** — the end user's own Privy token. *Which person it is for.*
  Writes only. The Sign Service verifies this, and it is the only thing that can authorize a
  signature.

Outcomes of a write:
- `executed` — MCP auto-signed via the Sign Service (needs an active session).
- `needs_wallet_sign` — the browser signs the XDR **MCP built** (`sign-xdr.ts`). It does not
  rebuild locally; rebuilding produced bogus "XLM not set in the Registry" errors.
- `needs_wallet_bind` — Privy "connect wallet" is *not* signing authority. The binding is a
  row in the Sign Service written when the user authorizes the Vanna quorum as an
  additional signer. No wallet-connect modal can produce it.
- **Local fallback** — on a budget-class simulation failure for an op the browser can run,
  the response carries an executable action and no XDR, which routes to `executeAction` →
  the site's own audited service. Used because `withdraw_collateral_balance` trips
  `HostError(Budget, ExceededLimit)` in *simulation* while succeeding on submit; the Margin
  page has always submitted these anyway.

**Auto-sign executes single-leg writes with no preview and no approval click.** That is the
documented design, and it is the thing to know before running any write test.

## 6. Assets

Three facts that make this domain awkward, all real, all in `registry/assets.ts`:

1. **"USDC" is not an asset.** BLUSDC, AQUSDC and SOUSDC are three separate SACs. Bare
   "USDC" on a write is a *question*, never a guess — picking one is unrecoverable.
2. **One token spells itself differently per venue.** Blend USDC is `BLUSDC` to a user and
   `USDC` to the margin contract, which *rejects* the string "BLUSDC".
3. **Three tokens, one price.** All dollar stables read one oracle feed, which is what makes
   a cross-stable leverage conversion correct.

Venue symbols are verified against recorded live MCP reads (`chain-facts.json`); only the
aliases are hand-authored, because language is the one thing the chain cannot tell us.

## 7. Key files

| File | Owns |
|---|---|
| `lib/copilot/handle.ts` | Orchestration: every branch above |
| `lib/copilot/router.ts` | Deterministic keyword routing, slot parsing |
| `lib/copilot/step-extractor.ts` | Clause → ordered legs, read legs, anaphora |
| `lib/copilot/plan-approval.ts` | Freeze / fingerprint / verify |
| `lib/copilot/registry/{assets,intent,workflows}.ts` | One answer per question: what an asset is, what a slot is, what order legs run in |
| `lib/copilot/mcp-client.ts` | Transport, the 14-dispatcher translation, credentials |
| `lib/copilot/mcp-write.ts` | Op → MCP tool, preflights, error humanisation |
| `lib/copilot/vertex.ts` | All model calls, thinking config, token logging |
| `lib/copilot/{domain-firewall,conditional-guard,residue}.ts` | Refusals |
| `components/copilot/plan-approval-card.tsx` | The approval card |
| `components/copilot/run-execution-card.tsx` | Live run + receipt |
| `components/copilot/{sign-xdr,execute}.ts` | Signing; local executor fallback |

## 8. MCP

`https://mcp.vanna.finance/mcp`, WorkOS M2M, Streamable HTTP. The server consolidated ~42
fine-grained tools into **14 dispatchers** taking `{action, kwargs}`. `kwargs` is
byte-identical to the old argument object, so translation happens at the transport boundary
(`LEGACY_TOOL_MAP` + `toServerCall`) and the router, arg builders and UI labels never had to
change. Callers still use legacy names; new-style names pass through.

## 9. Observability

`COPILOT_LOG=1` gives one line per turn plus one per model call:

```
[copilot:vertex] answer prompt=906 cached=0 (0%) output=48 thoughts=112
[copilot] {"event":"turn","template_id":"query_price","execution":null,...}
```

`thoughts=` is the number that explains cost and latency. The turn line's
`privy_token_present` / `bound_kind` / `signed_in` fields answer "which hop dropped the
user identity" without guessing from a symptom three services away.
