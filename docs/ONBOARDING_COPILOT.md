# Vanna Copilot Orchestrator — Developer Onboarding

> ## ⚠️ HISTORICAL — DO NOT ONBOARD FROM THIS FILE
>
> This describes a **FastAPI Python orchestrator** (`app/orchestrator/pipeline.py`,
> `app/mcp/client.py`). **That service no longer exists in this repo.** The brain is
> in-process TypeScript under `lib/copilot/` (38 modules), called from
> `POST /api/copilot`.
>
> Current docs, in reading order:
> **[copilot/ARCHITECTURE.md](./copilot/ARCHITECTURE.md)** ·
> **[copilot/README.md](./copilot/README.md)** ·
> **[copilot/GUARDRAILS.md](./copilot/GUARDRAILS.md)** ·
> **[copilot/ONBOARDING.md](./copilot/ONBOARDING.md)**
>
> Kept only because the design intent — templates, zero-custody, "the LLM interprets
> language; the code decides safety" — carried over and is still accurate.

_For a developer who has never seen this project. Every path, function, template,
and command below comes from the actual code in this repo._

---

## 1. What it is

The Copilot Orchestrator sits **on top of** the Vanna MCP server. It takes a user's
plain-English request and turns it into a **safe, previewable plan** built from a
fixed catalog of audited templates. The split is strict: **the LLM interprets
language; deterministic Python code decides safety.** It is **zero-custody** — the
action path returns an *unsigned preview* the user confirms and signs elsewhere
(Privy + Soroban RPC); this service never signs or submits anything (see
[pipeline.py](../app/orchestrator/pipeline.py) lines 10-11). It talks to the MCP
server as a first-party, server-to-server client using **WorkOS machine-to-machine
(M2M) auth** — the OAuth2 `client_credentials` flow — exchanging a client id +
secret for a short-lived JWT it sends as a Bearer token (see
[client.py](../app/mcp/client.py) lines 5-13).

**One line to remember:** the LLM interprets language; the code decides safety.

---

## 2. Architecture / flow

There are two paths, both starting from `handle()` in
[pipeline.py](../app/orchestrator/pipeline.py#L81). The parser picks exactly one
template id; the pipeline routes to the **query branch** if that id is a query
([queries.get(id)](../app/templates/queries.py#L68) is not `None`), otherwise to
the **action pipeline**.

### Action pipeline (5 steps)

```
user message
    │
    ▼
[1] INTENT     intent.parse() → Gemini → {template_id, slots}   (LLM)
    │                                     + deterministic remap/completeness guard
    ▼
[2] VALIDATE   slot completeness (2a) + policy limits (2b)       (deterministic)
    │            validate_slots(): leverage ≤ 10, allowed venues, ranges
    ▼
[3] PLAN       planner.build_plan(): the template's FIXED tool   (MCP recipe)
    │            sequence → resolve args → run reads / build XDR
    ▼
[4] RISK GATE  risk_gate.evaluate(): ALLOW / BLOCK /             (deterministic HARD)
    │            NEEDS_CONFIRMATION
    ▼
[5] PREVIEW    Preview(...) → kind="preview"                     NOTHING signed here
```

Reference: steps are numbered in the code — intent at
[pipeline.py:85](../app/orchestrator/pipeline.py#L85), validate at
[125-152](../app/orchestrator/pipeline.py#L125-L152), plan at
[155](../app/orchestrator/pipeline.py#L155), risk gate at
[158](../app/orchestrator/pipeline.py#L158), preview at
[167](../app/orchestrator/pipeline.py#L167).

### Query branch (shorter, read-only)

```
user message
    │
    ▼
[1] INTENT     intent.parse() → {template_id (a query id), slots}     (LLM)
    │
    ▼
[2] VALIDATE   slot completeness only (no policy limits, no risk gate)
    │
    ▼
[3] LIVE READ  planner.resolve_args() → mcp.call(single read tool)
    │            (if it needs account context → kind="unavailable")
    ▼
[4] EXPLAIN    llm.explain(question, tool, raw_data)                  (LLM)
    │            uses ONLY the returned numbers
    ▼
[5] ANSWER     ChatResponse(kind="answer")
```

Reference: `_handle_query()` at
[pipeline.py:36-78](../app/orchestrator/pipeline.py#L36-L78).

---

## 3. Repo layout

```
vanna-copilot-orchestrator/
├── app/
│   ├── llm/
│   │   ├── base.py       # LLMProvider ABC — parse_intent() + explain()
│   │   ├── vertex.py     # VertexProvider — real Gemini 3.5 Flash on Vertex AI
│   │   ├── mock.py       # MockLLM — offline keyword/regex parser (default)
│   │   └── factory.py    # get_llm() provider selection + catalog_prompt() builder
│   ├── orchestrator/
│   │   ├── intent.py     # parse() — thin wrapper over the active LLM provider
│   │   ├── pipeline.py   # handle() — the 5-step action flow + query branch
│   │   ├── planner.py    # TOOL_ARGS mapping + build_plan() + resolve_args()
│   │   └── risk_gate.py  # evaluate() — deterministic ALLOW/BLOCK/NEEDS_CONFIRMATION
│   ├── templates/
│   │   ├── registry.py   # the 25 action templates (TemplateDef recipes)
│   │   ├── queries.py    # the 3 read-only query templates (QueryTemplate)
│   │   └── slots.py      # validate_slots() — policy-limit validation
│   ├── mcp/
│   │   └── client.py     # MockMCPClient + LiveMCPClient (WorkOS M2M + Streamable HTTP)
│   ├── config.py         # Settings — env > .env > defaults
│   └── schemas.py        # Pydantic contracts (ChatRequest/Response, ParsedIntent, …)
├── scripts/
│   ├── try_intent.py     # probe the LLM intent parser ALONE
│   └── try_pipeline.py   # drive the full pipeline end-to-end
├── docs/                 # this document
├── requirements.txt      # dependencies (core + optional vertex/live extras)
├── .env / .env.example   # settings + secrets (.env never committed)
└── README.md
```

---

## 4. The LLM

- **Model:** Gemini **3.5 Flash** on **Vertex AI** (real API calls). Default model id
  `gemini-3.5-flash`, set via `VERTEX_MODEL` ([config.py:42](../app/config.py#L42)).
- **CRITICAL config: `GOOGLE_CLOUD_LOCATION=global`.** The google-genai SDK routes by
  the *exact* location string. Only `"global"` targets the real host
  `https://aiplatform.googleapis.com/`. Any other value (a stray space, wrong case,
  empty, or a real region) falls through to `https://{location}-aiplatform.googleapis.com/`,
  and for `"global"` that becomes `global-aiplatform.googleapis.com` — **a host that
  does not exist, so the request hangs forever with no error.** `vertex.py` normalizes
  the string hard and raises loudly if the SDK resolves a regional host. See
  [vertex.py:152-201](../app/llm/vertex.py#L152-L201).
- **Two jobs** (the `LLMProvider` interface, [base.py](../app/llm/base.py)):
  1. **`parse_intent`** — read the user message + template catalog → return strict JSON
     `{ template_id, slots, confidence }` ([vertex.py:203](../app/llm/vertex.py#L203)).
  2. **`explain`** (queries only) — take the raw JSON a read tool returned and explain
     it in plain English, using **ONLY** those values. The system prompt forbids
     inventing, recalling, or adding any number not in the data, and tells it to prefer
     human-readable / `*_pct` / `*_usd` fields over raw wad integers
     ([vertex.py:269-324](../app/llm/vertex.py#L269-L324)).
- **Fills structural slots** (asset, token pair, dex, leverage, thresholds) whenever the
  message provides them. **Never fills money/account slots** — `amount`,
  `source_account`, `target_account` — which are collected as separate frontend input
  fields. A bare quantity like the 500 in "put 500 USDC" is the *amount* (omitted); the
  USDC is the *asset* (filled). See the system prompt at
  [vertex.py:49-117](../app/llm/vertex.py#L49-L117) and `_MONEY_ACCOUNT_SLOTS` in
  [mock.py:31](../app/llm/mock.py#L31).
- **Its confidence score is ignored** for safety. Slot completeness is re-verified by
  deterministic code after the model runs, no matter how confident it claimed to be —
  this is what stops a high-confidence-but-empty intent from proceeding
  ([pipeline.py:127-136](../app/orchestrator/pipeline.py#L127-L136),
  [vertex.py:360-400](../app/llm/vertex.py#L360-L400)).

There is also an offline `MockLLM` ([mock.py](../app/llm/mock.py)) — deterministic
keyword/regex matching, no LLM, no keys. It proves the wiring, not model quality. It is
the default (`LLM_PROVIDER=mock`).

---

## 5. Templates

A template is `intent phrase + fixed MCP tool-call sequence + policy limits`. The LLM
only picks one id and fills its slots; **it cannot invent tools or steps** — the
sequence comes solely from the audited registry recipe (this is the "P6" safety
guarantee in code form, [planner.py:6-7](../app/orchestrator/planner.py#L6-L7)).

### 25 action templates ([registry.py](../app/templates/registry.py))

| # | id | category | required slots | available |
|---|---|---|---|---|
| 1 | `lend_open_vanna` | lending | asset | ✅ (free tier) |
| 2 | `lend_blend_5x` | lending | asset | ✅ |
| 3 | `lend_blend_custom` | lending | asset, leverage | ✅ |
| 4 | `lp_aquarius_5x` | liquidity | token_a, token_b | ❌ (`aquarius_add_lp` not built) |
| 5 | `lp_soroswap_5x` | liquidity | token_a, token_b | ❌ (`soroswap_add_lp` not built) |
| 6 | `lp_custom` | liquidity | dex, leverage, token_a, token_b | ❌ (`dex_add_lp` not built) |
| 7 | `close_if_apy_below` | position mgmt | threshold | ✅ |
| 8 | `close_if_borrow_apr_above` | position mgmt | threshold | ✅ |
| 9 | `close_if_utilization_above` | position mgmt | threshold | ✅ |
| 10 | `close_if_net_yield_negative` | position mgmt | (none) | ✅ |
| 11 | `close_if_hf_below` | position mgmt | value | ✅ |
| 12 | `close_if_leverage_above` | position mgmt | value | ✅ |
| 13 | `take_profit` | position mgmt | profit | ✅ |
| 14 | `stop_loss` | position mgmt | loss | ✅ |
| 15 | `repay_and_close` | position mgmt | (none) | ✅ |
| 16 | `migrate_highest_yield` | yield opt | (none) | ✅ |
| 17 | `rebalance_leverage` | yield opt | leverage | ✅ |
| 18 | `reinvest_rewards` | yield opt | (none) | ❌ (`rewards_harvest` not built) |
| 19 | `harvest_and_swap` | yield opt | (none) | ❌ (`rewards_harvest` + `dex_swap` not built) |
| 20 | `compound_rewards` | yield opt | cadence | ❌ (`rewards_harvest` not built) |
| 21 | `maintain_hf_above` | risk mgmt | value | ✅ |
| 22 | `reduce_leverage_on_volatility` | risk mgmt | (none) | ✅ |
| 23 | `exit_on_stale_oracle` | risk mgmt | (none) | ✅ |
| 24 | `pause_on_emergency` | risk mgmt | (none) | ✅ (read-only) |
| 25 | `notify_before_close` | risk mgmt | (none) | ✅ (free tier, preference flag) |

The 6 templates marked ❌ set `available=False` because a tool in their sequence isn't
live on the MCP server yet — `handle()` returns `kind="unavailable"` for them
([pipeline.py:110-115](../app/orchestrator/pipeline.py#L110-L115)).

**Fixed vs custom:** a fixed template (e.g. `lend_blend_5x`) encodes a canonical
leverage and declares **no** `leverage` slot. An explicit number in the message routes
to the `*_custom` sibling instead (see §12 and `_FIXED_TO_CUSTOM` at
[vertex.py:43-47](../app/llm/vertex.py#L43-L47)).

### 3 query templates ([queries.py](../app/templates/queries.py))

| id | tool | required slots | notes |
|---|---|---|---|
| `query_pool_stats` | `vanna_get_pool_stats` | asset | pool APR/APY/utilization |
| `query_price` | `vanna_get_price` | asset | current asset price |
| `query_account_health` | `vanna_get_account_health` | (none) | `requires_account=True` — needs a resolved smart_account (no account layer yet) |

---

## 6. Argument mapping ([planner.py](../app/orchestrator/planner.py))

Copilot slots (`asset`, `leverage`) are **not** the same as real MCP tool params
(`symbol`, `smart_account`, `amount`). `planner.py` holds a **per-tool mapping table,
`TOOL_ARGS`** ([planner.py:123-228](../app/orchestrator/planner.py#L123-L228)), the
source of truth that declares, for each tool, where each real param comes from:

- **`FromSlot(name)`** — value comes from a template slot, with slot→param translation.
  Example: `vanna_get_pool_stats` maps `symbol` ← `FromSlot("asset")`
  ([planner.py:125](../app/orchestrator/planner.py#L125)). Values pass through
  case-preserved.
- **`FromAccount(field)`** — value comes from the resolved account context
  (`trader` or `smart_account`). Example: `vanna_get_account_health` maps
  `smart_account` ← `FromAccount("smart_account")`
  ([planner.py:131](../app/orchestrator/planner.py#L131)).
- **`Computed(note)`** — value must be *derived* and can't be resolved yet. Right now
  this is only ever amounts, including the leverage→deposit/borrow conversion, all
  tagged `_LEVERAGE_AMOUNT_TODO` ([planner.py:108-113](../app/orchestrator/planner.py#L108-L113)).

`resolve_args()` ([planner.py:256](../app/orchestrator/planner.py#L256)) builds a tool's
args and returns `runnable=False` with `blockers` when something is missing. The
behaviour that matters:

- **Market-data reads run fully** once their symbol(s) are known — `vanna_get_pool_stats`,
  `vanna_get_price`, `vanna_get_prices_batch`, `vanna_list_protocol_addresses` need no
  account.
- **Account-scoped tools and all writes short-circuit** with a "requires account
  context" blocker when no account layer is present. They are **never called with
  placeholder accounts** — `build_plan()` records a `not_executed` result instead of
  calling the tool ([planner.py:334-337](../app/orchestrator/planner.py#L334-L337)).
- **Leverage → amount math is an explicit `TODO(amount-layer)`.** Every amount is
  `Computed(...)` so the planner **refuses to guess it** rather than fabricate a number.
- If a tool in a recipe has **no** `TOOL_ARGS` entry, `resolve_args()` raises
  `PlannerError` (fail loud) ([planner.py:264-270](../app/orchestrator/planner.py#L264-L270)).

The account context is currently always empty — `build_plan()` constructs a bare
`AccountContext()` with a `TODO(account-layer)` note
([planner.py:318-324](../app/orchestrator/planner.py#L318-L324)).

---

## 7. Run locally

Both scripts are runnable modules. `try_pipeline.py` forces `MCP_MODE=mock` /
`LLM_PROVIDER=mock` **unless you override them in the shell first** (it uses
`setdefault`, so a shell export wins — [try_pipeline.py:29-30](../scripts/try_pipeline.py#L29-L30)).
`try_intent.py` does not force anything and uses whatever the env / `.env` says.

```powershell
# activate the venv (PowerShell)
.\.venv\Scripts\Activate.ps1

# point at real Gemini + the live MCP server
$env:LLM_PROVIDER="vertex"; $env:MCP_MODE="live"

# 1) parse only (LLM intent, nothing else)
python -m scripts.try_intent "put 500 USDC into Blend at 5x leverage"

# 2) full pipeline — a live read-only QUERY
python -m scripts.try_pipeline "what's the USDC pool APR"

# 3) full pipeline — an ACTION reaching a preview
python -m scripts.try_pipeline "open a lending position in Vanna for XLM"
```

### Expected output shapes

**A live query** (`kind="answer"`, plain-English explanation of live data):

```
KIND  : answer
MSG   : The USDC pool currently shows a supply APY of 5.2% and a borrow APR of 3.1%, with utilization at 64%.
INTENT: template=query_pool_stats conf=... slots={'asset': 'USDC'}
```

**An action preview** (`kind="preview"`, planned tool sequence + risk decision):

```
KIND  : preview
MSG   : Open a lending position on Vanna (asset=XLM). Steps: vanna_open_account -> vanna_deposit_collateral -> vanna_lend. Risk: allow — within policy limits.
INTENT: template=lend_open_vanna conf=... slots={'asset': 'XLM'}
RISK  : allow — within policy limits
TOOL_CALLS:
  - vanna_open_account  is_write=True  args={...}
  - vanna_deposit_collateral  is_write=True  args={...}
  - vanna_lend  is_write=True  args={...}
UNSIGNED_XDRS: (none)          # see §10 caveat: writes short-circuit without account context
REQUIRES_SIGNATURE: False
```

**A leverage block** (over the policy max of 10 → `kind="blocked"`):

```
KIND  : blocked
MSG   : Blocked by risk policy: leverage 15 exceeds policy max 10.0
INTENT: template=lend_blend_custom conf=... slots={'asset': 'USDC', 'leverage': 15}
```

**An account-scoped query** (no account layer → `kind="unavailable"`):

```
KIND  : unavailable
MSG   : That query requires account context (smart_account) — not yet implemented. (No account layer exists yet, so account-scoped reads can't run.)
INTENT: template=query_account_health conf=... slots={}
```

---

## 8. Environment variables

All settings resolve **shell env > `.env` file > hardcoded default**
([config.py](../app/config.py)). `.env` is loaded with `override=False`, so a value
already in the shell is never clobbered.

| Var | What it is | Correct value |
|---|---|---|
| `LLM_PROVIDER` | which LLM provider | `vertex` for real Gemini (`mock` offline; `openrouter` is a not-yet-implemented Phase 2 stub) |
| `MCP_MODE` | mock vs live MCP calls | `live` to hit the real server (`mock` = canned responses) |
| `GOOGLE_CLOUD_PROJECT` | Vertex project id | your GCP project |
| `GOOGLE_CLOUD_LOCATION` | Vertex region | **`global`** (required — see §4; any other value hangs) |
| `VERTEX_MODEL` | Gemini model id | `gemini-3.5-flash` |
| `MCP_BASE_URL` | MCP server endpoint | `https://mcp.vanna.finance/mcp` |
| `WORKOS_M2M_CLIENT_ID` | WorkOS M2M client id | from WorkOS (in `.env`) |
| `WORKOS_M2M_CLIENT_SECRET` | WorkOS M2M secret | from WorkOS (in `.env`) |
| `WORKOS_M2M_TOKEN_URL` | token endpoint | the AuthKit **`/oauth2/token`** URL — **not** `https://api.workos.com/sso/token` |
| `MIN_HEALTH_FACTOR` | risk floor | `1.30` |
| `MAX_LEVERAGE` | risk cap | `10` |
| `MAX_POSITION_USD` | risk cap | `50000` |

> ⚠️ **The `WORKOS_M2M_TOKEN_URL` default in code is `https://api.workos.com/sso/token`
> ([config.py:55](../app/config.py#L55)), which is NOT the working value.** The correct
> URL is the AuthKit `/oauth2/token` endpoint — set it explicitly in `.env`.

> 🔒 **Secrets** (`WORKOS_M2M_CLIENT_SECRET`, client id) live in `.env` and **must never
> be committed.** `.env.example` is the safe template. If you find real secrets checked
> in, rotate them.

---

## 9. Verify it yourself

Run these in order (with `.venv` active). Each has an expected result.

**(a) Intent parsing alone** — the LLM path works:

```powershell
$env:LLM_PROVIDER="vertex"
python -m scripts.try_intent "provide 1000 of XLM/USDC liquidity on Soroswap at 3x"
# → JSON with template_id="lp_custom", slots {dex:Soroswap, leverage:3, token_a:XLM, token_b:USDC}
#   (1000 is the amount → correctly omitted)
```

**(b) A live query returns real data** — end-to-end query path:

```powershell
$env:LLM_PROVIDER="vertex"; $env:MCP_MODE="live"
python -m scripts.try_pipeline "what is the price of XLM"
# → KIND: answer, with a plain-English sentence built ONLY from the live numbers
```

**(c) An action reaches a preview** — action path with a risk decision:

```powershell
python -m scripts.try_pipeline "open a lending position in Vanna for XLM"
# → KIND: preview, RISK: allow — within policy limits, TOOL_CALLS listed
```

**(d) 15x leverage is blocked** — the deterministic risk gate fires:

```powershell
python -m scripts.try_pipeline "open a 15x leveraged lending position on Blend using USDC"
# → KIND: blocked, MSG: "Blocked by risk policy: leverage 15 exceeds policy max 10.0"
```

**(e) An account-scoped query returns "requires account context"**:

```powershell
python -m scripts.try_pipeline "what is the health factor of my account"
# → KIND: unavailable, MSG: "...requires account context (smart_account) — not yet implemented..."
```

**Direct MCP-client arg-mapping check** — proves `asset`→`symbol` translation works
against the live server (a market-data read needs no account):

```powershell
$env:MCP_MODE="live"
python -c "from app.mcp.client import get_mcp_client; from app.orchestrator import planner; r=planner.resolve_args('vanna_get_pool_stats', {'asset':'USDC'}, planner.AccountContext()); print('resolved args:', r.args, 'runnable:', r.runnable); print('live result:', get_mcp_client().call(r.tool, r.args, 'GDEMOUSER1234'))"
# → resolved args: {'symbol': 'USDC'} runnable: True
#   live result: {... real pool stats from the MCP server ...}
```

---

## 10. Current state & what's left to do

### Live today (verified)

- Real **Gemini intent parsing** for both actions and queries.
- **Deterministic gates:** slot completeness, policy-limit validation (leverage cap,
  allowed venues/ranges), out-of-scope rejection.
- **Per-tool argument mapping** to real MCP signatures (`TOOL_ARGS`).
- **Live WorkOS M2M connection** to the frozen MCP server.
- **Query path end-to-end:** real question → live on-chain data → plain-English answer.
- **Action templates reach a preview** with a real risk decision.

### Honest caveat (do not overstate)

An action **preview today shows the planned tool sequence and the risk approval, but
does NOT build a real unsigned XDR yet.** The write tools short-circuit without account
context ([planner.py:334-337](../app/orchestrator/planner.py#L334-L337)), so
`unsigned_xdrs` is empty and `requires_signature` is `False`. **The plan is real; the
transaction is built once the account/Privy layer lands.** Don't claim it "built the
transaction."

### Left to do / blockers

Almost everything remaining clusters on **one missing piece: the account + amount +
signing layer (frontend + Privy)** — owner-owned.

| Blocked | Unblocks when… |
|---|---|
| Account-scoped reads (health, debt, collateral) | account resolution exists (trader `G…` + smart_account `C…`) |
| Write execution (signed) | amount input + Privy signing exist |
| Leverage → amount math (`planner.py` TODO) | the amount layer exists |
| The 6 LP/rewards templates (`available=False`) | those MCP tools get built server-side |

Plus:

- **The repo is not yet under git** in a baseline commit — first housekeeping task is
  `git init` + a baseline commit.
- **Optional cosmetic:** query explanations can still surface raw wad/decimal internals;
  the `explain` prompt already asks the model to prefer human-readable fields, but this
  can be tightened.

---

## 11. First tasks for a new dev

1. Set up `.venv`, `pip install -r requirements.txt`, and get `.env` from the team
   (WorkOS M2M creds + the correct AuthKit `/oauth2/token` URL).
2. Run `scripts/try_pipeline` on a **live query** and an **action** — see both paths
   with your own eyes (§7).
3. Read `handle()` in [pipeline.py](../app/orchestrator/pipeline.py#L81) top-to-bottom,
   then the `TOOL_ARGS` table in [planner.py](../app/orchestrator/planner.py#L123).
4. `git init` the repo and make a baseline commit.
5. Then: help design the **account-context interface** — how a signed-in user resolves
   to `trader` + `smart_account` (`AccountContext` in
   [planner.py:51-64](../app/orchestrator/planner.py#L51-L64)). It's the keystone that
   unblocks account-scoped reads, write execution, and the leverage→amount math.

---

## 12. Design rules (do not break)

- **The LLM interprets; deterministic code decides safety.** The model's confidence is
  advisory only; slot completeness and policy limits are re-checked in code.
- **Explicit numbers route to `*_custom` templates** with the number in a validated
  `leverage` slot (`_remap_fixed_to_custom` at
  [vertex.py:337-358](../app/llm/vertex.py#L337-L358)). Never add a `leverage` slot to a
  fixed `*_5x` template.
- **Never call a write tool with a placeholder account** — account-scoped calls
  short-circuit as `not_executed` until a real `AccountContext` exists.
- **Query explanations use only the tool's returned data** — never outside knowledge or
  invented numbers ([base.py:31-40](../app/llm/base.py#L31-L40),
  [vertex.py:269-281](../app/llm/vertex.py#L269-L281)).
- **Don't touch the frozen MCP server** except for the copilot connection.
