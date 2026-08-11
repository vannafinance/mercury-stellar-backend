# Vanna Copilot — architecture

Diagrams for the whole system: services, the path a message takes, the write and plan
lifecycles, identity, and multi-leg execution.

Read with:
- [README.md](./README.md) — prose reference for the same system
- [GUARDRAILS.md](./GUARDRAILS.md) — every refusal and safety gate, and where it lives
- [ONBOARDING.md](./ONBOARDING.md) — run it in ~15 minutes

> **Stale-doc warning.** `docs/ONBOARDING_COPILOT.md` and `docs/copilot-integration-plan.md`
> describe a **FastAPI Python orchestrator** (`app/orchestrator/pipeline.py`, `app/mcp/`).
> That service does not exist in this repo. The brain is **in-process TypeScript** under
> `lib/copilot/` (38 modules). Do not hand those two files to a new developer.

---

## 1. Services

Four processes. Only the browser ever holds a signing key.

```mermaid
flowchart LR
  subgraph Browser
    UI["/copilot workspace<br/>components/copilot/*"]
    W["Privy embedded wallet<br/>(signs XDR)"]
  end
  subgraph NextServer["Next.js server (this repo)"]
    API["POST /api/copilot"]
    BRAIN["Brain — lib/copilot/*<br/>route · plan · risk · execute"]
  end
  MCP["Vanna MCP<br/>mcp.vanna.finance/mcp<br/>14 dispatchers"]
  SIGN["Sign Service<br/>auto-sign policy + bindings"]
  CHAIN["Stellar / Soroban<br/>testnet"]
  VTX["Vertex AI<br/>gemini-3.6-flash"]

  UI -->|"message"| API --> BRAIN
  BRAIN <-->|"language only"| VTX
  BRAIN <-->|"reads · builds · simulates"| MCP
  MCP <-->|"auto-sign"| SIGN
  BRAIN -->|"unsigned XDR"| UI
  UI --> W -->|"signed tx"| CHAIN
  MCP --> CHAIN
  BRAIN -->|"computeMarginSnapshot<br/>(same read the Margin page uses)"| CHAIN
```

**The load-bearing rule:** Vertex only ever interprets *language*. Amounts, assets,
ordering, refusals and execution are deterministic code. Every bug that looked like "the
model said something plausible and wrong" came from bending this.

---

## 2. The path a message takes

`lib/copilot/handle.ts` → `handleChat()`. Order is deliberate; several branches exist
specifically to run *before* something more expensive or less safe.

```mermaid
flowchart TD
  IN["POST /api/copilot"] --> CLIENT{"structured client action?"}
  CLIENT -->|"summarize_execution<br/>approved_plan"| REPLAY["replay VERBATIM<br/>never re-infer"]
  CLIENT -->|no| FW{"domain firewall"}
  FW -->|"off-domain"| REFUSE1["refuse — before spending a token"]
  FW -->|ok| AUTOSIGN{"auto-sign control?"}
  AUTOSIGN -->|yes| AS["enable / disable / caps"]
  AUTOSIGN -->|no| RESUME{"resume?"}
  RESUME -->|"pending_write<br/>resume_multi_leg"| CONT["continue chain<br/>never re-route original"]
  RESUME -->|no| PAGE{"page-assistant question?"}
  PAGE -->|yes| CONCEPT["page agent — no MCP, no writes"]
  PAGE -->|no| ROUTE["ROUTING"]

  ROUTE --> KW{"keyword router confident?"}
  KW -->|yes| SKIP["skip Vertex entirely"]
  KW -->|no| VERTEX["vertexSelectTool (function-calling)"]
  VERTEX --> FIX["deterministic corrections re-applied<br/>venue · USDC variant · unsupported asset"]
  SKIP --> EXTRACT
  FIX --> EXTRACT["plan extraction<br/>step-extractor + plan-sanitize + residue"]

  EXTRACT --> GAP{"conditional / standing order?"}
  GAP -->|yes| REFUSE2["refuse — will not act on<br/>a condition it cannot watch"]
  GAP -->|no| KIND{"kind?"}
  KIND -->|read| READ["runRead()"]
  KIND -->|"single write"| WRITE["runWrite()"]
  KIND -->|"multi-leg plan"| PLAN["freezePlan() → approval card"]
```

### Why the order matters

| Step | Runs before | Because |
|---|---|---|
| `approved_plan` replay | routing | Re-running the model could produce a *different* plan than the user approved |
| Domain firewall | Vertex | Off-domain prompts must not cost a token |
| Resume | routing | Re-routing the original prompt would re-execute legs already on chain |
| Amount/leverage validation | wallet check | Otherwise `-5 USDC` answers "connect your wallet", hiding the real problem |

---

## 3. Reads

Position questions bypass MCP on purpose.

```mermaid
flowchart LR
  Q["health / collateral / debt"] --> SNAP["computeMarginSnapshot<br/>lib/account-snapshot.ts"]
  SNAP --> ANS["answer"]
  Q2["price · pool stats · protocol"] --> MCP["MCP tool"] --> FMT["vertexExplainStructured<br/>(thinking: low)"] --> ANS
```

`computeMarginSnapshot` is **the same on-chain read the Margin page renders**. This is an
override, not a fallback: MCP reports only the recorded balance while the site also
reconciles raw SAC holdings. They disagreed — $214.72 vs $382.87 of collateral, HF 1.95 vs
3.47. Two different answers to "am I about to be liquidated" is the worst failure this
surface has.

---

## 4. A single write

```mermaid
flowchart TD
  A["action + slots"] --> V["static validation<br/>amount > 0 · leverage ≤ cap · asset supported"]
  V -->|fail| B1["blocked — before wallet check"]
  V --> FRAC{"sized by a share?"}
  FRAC -->|"50% / half / max"| SIZE["resolveBalanceFractionAmount<br/>wallet · collateral · or margin free balance"]
  FRAC -->|no| USDC
  SIZE --> USDC{"bare USDC?"}
  USDC -->|yes| ASK["clarify — BLUSDC / AQUSDC / SOUSDC<br/>never guess"]
  USDC -->|no| RISK["evaluateWriteRisk()<br/>before → after simulation"]
  RISK -->|block| B2["blocked with reason"]
  RISK --> BUILD["MCP builds + simulates → XDR"]
  BUILD --> OUT{"outcome"}
  OUT -->|"auto-sign session active"| EXEC["executed on chain"]
  OUT -->|"refusal WITH usable XDR"| SIGNW["needs_wallet_sign<br/>browser signs MCP's XDR"]
  OUT -->|"no binding"| BIND["needs_wallet_bind"]
  OUT -->|"budget error in simulation"| LOCAL["local executor fallback<br/>same service the Margin page uses"]
```

**A refusal to auto-sign is not a failed transaction.** If MCP built a usable XDR, the leg
is staged for the wallet. Getting this wrong is what made account creation fail whenever
auto-approve was off — the built XDR was discarded and an error reported instead.

---

## 5. Plan lifecycle — freeze, fingerprint, replay

```mermaid
sequenceDiagram
  participant U as User
  participant B as Brain
  participant C as Approval card
  participant M as MCP
  participant W as Wallet

  U->>B: "deposit 300 XLM, borrow 30 BLUSDC, supply to Blend, then tell me my HF"
  B->>B: extract → coalesce → freezePlan()
  Note over B: plan_id = sha256(every executable slot)
  B->>C: 4 steps · 3 signatures · read leg = "no signature"
  U->>C: Approve & run
  C->>B: approved_plan { plan_id, steps }
  B->>B: verifyApprovedPlan() — recompute hash
  alt hash mismatch or > 5 min old
    B-->>U: refuse, show a fresh plan
  else valid
    loop each write leg
      B->>M: build + simulate
      M-->>B: XDR
      B->>W: sign
      W-->>B: tx hash
      B->>B: wait for ledger before next leg
    end
    B->>B: read legs run AFTER writes settle
    B-->>U: receipt
  end
```

Two properties this buys:

1. **What executes is what was approved.** The fingerprint covers *every* executable slot,
   derived by iterating `EXECUTABLE_SLOTS` — not a hand-picked list. Hand-picking is how
   `leverage`, then `borrow_asset`, then `token_out` each fell outside the hash. An
   approved "deposit 500 AQUSDC, borrow XLM at 3×" once replayed as `borrow 1000 AQUSDC`.
2. **Read legs are first-class.** "…then tell me my health factor" is shown as a
   non-signing row, excluded from the signature count, included in the fingerprint, and run
   **after** the writes settle. A report on pre-action state answers the wrong question.

---

## 6. Multi-leg execution

Ops that cannot be atomic are split, with the protocol reason recorded next to the rule in
`registry/workflows.ts`.

```mermaid
flowchart LR
  subgraph "deposit_and_borrow"
    D1["deposit collateral"] --> W1["wait: sequence applied"] --> D2["borrow"]
  end
  subgraph "levered Blend farm"
    F1["deposit"] --> F2["borrow"] --> F3["supply<br/>NET of 0.35% origination fee"]
  end
```

- `deposit_and_borrow` is split because MCP's combined call runs `is_borrow_allowed`
  against collateral *before* the deposit leg of the same call is credited.
- The farm supply leg uses the **net** borrow, not the gross — you can only supply what you
  actually received.
- Between legs the executor waits for the source account's sequence to be *applied* on
  Horizon. Skipping this produced `txBadSeq` on hop 2.
- Exactly one leg is settled per signature (`claimFirstAwaitingLeg`). Stamping every
  matching leg with one hash once marked legs 3 and 4 "done" against leg 2's transaction —
  claiming transactions that never happened.

---

## 7. Identity — two headers, never conflated

```mermaid
flowchart TD
  APP["Authorization: Bearer<br/>WorkOS M2M token"] --> Q1["WHICH APPLICATION is calling"]
  USER["X-Vanna-User-Assertion<br/>end user's Privy token"] --> Q2["WHICH PERSON it is for"]
  Q1 --> ALL["sent on every call"]
  Q2 --> WR["writes only — the ONLY thing that<br/>can authorize a signature"]
```

And three separate permissions that look alike and are not:

| # | Thing | Where it lives | Reconnecting the wallet fixes it? |
|---|---|---|---|
| 1 | Wallet **connected** | Browser / Privy session | — |
| 2 | Vanna is a **bound signer** | Row in the Sign Service (`addSigners` quorum) | **No** — needs explicit consent, once per wallet |
| 3 | Auto-sign **session** | Sign Service policy, with spend caps | No — separate from (2) |

`disable auto-sign` revokes (3) only: *"Privy addSigners was NOT removed."* So the bind is a
one-time step per wallet, not per session.

---

## 8. Repositories

| What | Path | Notes |
|---|---|---|
| Website + copilot | this repo | Next 16, Turbopack. Brain in `lib/copilot/` |
| MCP server (Python) | `../vanna_mcp` | git root is `vanna_mcp`; code in `vanna_mcp/vanna-mcp/` |
| Sign Service (Node/TS) | `vanna_mcp/vanna-mcp/sign-service/` | **not** the standalone `Documents/vanna-sign-service` |

---

## 9. Observability

`COPILOT_LOG=1` gives one line per turn plus one per model call:

```
[copilot:vertex] answer prompt=906 cached=0 (0%) output=48 thoughts=112
[copilot] {"event":"turn","template_id":"query_price","execution":null,...}
```

`thoughts=` explains cost and latency — thinking bills at output rates. The turn line's
`privy_token_present` / `bound_kind` / `signed_in` answer "which hop dropped the user
identity" without guessing from a symptom three services away.

**Measured warm latency (2026-08-10):** read 6.7s · 2-step plan 7.4s · 4-step plan 6.5s.
Never measure the first request after an edit — that is Turbopack recompiling, and it reads
9–60s regardless.
