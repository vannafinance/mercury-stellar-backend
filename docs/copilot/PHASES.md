# Phase numbering — the single source of truth

Three numbering schemes were used across earlier documents and they conflict. **This file
is canonical.** Where another document disagrees, this one wins.

The canonical scheme is the one in `HANDOFF-roadmap-v2.md`: **P0–P7** for app work, **M-A /
M-B / M-C** for MCP-side work.

---

## Current status

| Phase | What | Status |
|---|---|---|
| **P0** | Confirm Sign Service deploy completed the auto-approve safety fix | code done · **live check outstanding** |
| **M-A** | On-chain injection test (attacker-written token symbols) | `onchain-strings.ts` written · **untested live** |
| **P1** | Telemetry — OpenTelemetry GenAI + Langfuse | **trace read** · guest price 38.7s (`generate_content` 26.1s / 67%) · signed-in price 686ms (`vanna_get_price` 660ms / 96%) · signed-in health 16.2s (**scope 13.1s / 81%**) · UI http://localhost:3100 |
| **P2** | **Finish the planner cut** — `handle.ts` 8,717 → ~2,000, `router.ts` → read-through cache | **← current** · Task 0 done · peel 2: `unnamed-intent.ts` · `handle.ts` **8,164** · Privy auto-approve ON (not Freighter) · `/copilot` 5×5 + landed 1 XLM repay still open |
| **M-B** | MCP read/write split (confused-deputy fix) | not started · gates any public MCP exposure |
| **P3** | Durable state — Cloud SQL (sessions, approvals, checkpoints, standing orders, audit) | not started |
| **M-C** | MCP rate limiting, circuit breaker, per-tool timing | not started |
| **P4** | Audit log | not started |
| **P5** | Graded guardrail policy in one module | not started |
| **P6** | Execution-time revalidation (re-price before the first leg) | not started |
| **P7** | Revisit the runtime — decision point, not a planned migration | deferred by design |

**Also open, unnumbered:** `/api/mercury/events` 500 and slow `GET /api/account` (6–96s) are
out of copilot scope (app team). EPIPE handling landed in `lib/server/broken-pipe.ts`.
Remaining P2 work is in `HANDOFF-phase-P2-planner-cut.md`.

---

## Translating the older numbering

The production-readiness artifact used a different sequence. If you are reading that
document, translate:

| Artifact says | Canonical | What it is |
|---|---|---|
| P5 | **P1** | Telemetry |
| P6 | **P3** | Durable state |
| P7 | **P4** | Audit log |
| P8 | **P5** | Graded guardrails |
| P9 | **P7** | Runtime decision point |
| — | **P2** | The planner cut — the artifact listed it as a §9 gap rather than numbering it |
| M-A / M-B / M-C | same | MCP work, unchanged |

The original scheme (Phase 1, 2, 2.5, 2.7, 2.8, 2.9, 3) is **history** — those phases are
complete and their handoffs are kept for the record. Phase 3's Pass A landed; Pass B became
canonical **P2**.

---

## Which handoff to read

**Current:** `HANDOFF-phase-P2-planner-cut.md` — this phase's tasks.
**Plan:** `HANDOFF-roadmap-v2.md` — everything remaining, in order.
**Context:** `SESSION-HANDOFF.md` — full context for any agent picking this up cold.

Everything else in this directory is completed-phase history. Do not work from it.
