# Vanna Copilot — Knowledge Transfer (KT)

> Single doc to understand, run, and take over the Vanna Copilot. Read this
> first, then `copilot-integration-plan.md` (design detail) and
> `copilot-prompt-dictionary.md` (what users can ask).

---

## 1. What it is

An **agentic copilot** embedded in the Vanna app (`/copilot`): the user states a
natural-language intent ("borrow 20 USDC", "how is the USDC pool doing"), and the
copilot understands it, checks safety, previews the impact, and — on the user's
approval — executes it on-chain. It is **not** a support chatbot; it's an
action-executor + market/account assistant on Stellar/Soroban testnet.

**Design pillar — non-custodial:** the "brain" never holds keys or signs. It
only reasons + plans. Every write is signed by the user's own wallet (Privy or
Freighter) in the browser. A full server breach cannot move a single token.

---

## 2. Architecture (two repos)

```
┌───────────────┐   POST /api/copilot   ┌──────────────────┐   Gemini + MCP   ┌───────────┐
│  Frontend     │ ────────────────────► │  Brain            │ ───────────────► │ vanna-mcp │
│  /copilot UI  │                       │  (FastAPI, Python)│                  │ (~29 tools)│
│  Next.js      │ ◄──────────────────── │  Gemini + risk    │ ◄─────────────── └───────────┘
└──────┬────────┘   answer / preview    └──────────────────┘   live data / classify
       │ (write) execute via AUDITED services → Privy sign → Soroban RPC → confirm
       ▼
   on-chain
```

- **Frontend repo:** `mercury-stellar-backend` — branch **`advay-copilot-final`**
  (based on `feat/stellar-rewire`). Contains the UI + a proxy to the brain +
  the write executor that calls the app's own audited on-chain services.
- **Brain repo:** `vanna-copilot-orchestrator` (the Python FastAPI "brain").
  Does intent parsing (Gemini), MCP reads, risk gate, before→after simulation,
  and logging. **Not yet in shared version control — needs its own push.**

**Why writes go through the app's services, not the MCP:** the MCP's native
write tools are **blocked contract-side** (`deposit_usdc` non-existent,
`deposit_collateral_tokens` → InvalidAction). The app's own
`ContractService` / `MarginAccountService` call the correct functions and work
(same path that creates margin accounts). So: **brain = understand + risk;
frontend audited services = execute.**

---

## 3. How to run

**Brain** (port 8000):
```bash
cd vanna-copilot-orchestrator
.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```
- Needs `.env` (see §7) with `LLM_PROVIDER=vertex`, `MCP_MODE=live`, WorkOS M2M creds.
- Gemini needs **ADC**: `gcloud auth application-default login` (one-time; re-run if it expires — symptom: answers fall back to a terse summarizer instead of rich prose).
- Health check: `GET http://127.0.0.1:8000/health` → `{status, llm_provider, mcp_mode, templates}`.

**Frontend** (port 3000):
```bash
cd mercury-stellar-backend
npm run dev
```
- Needs `.env.local` with `NEXT_PUBLIC_PRIVY_APP_ID` (see §7).
- Open `http://localhost:3000/copilot`.

Both must be up for the copilot to work end-to-end.

---

## 4. File map

### Frontend (`mercury-stellar-backend`, branch `advay-copilot-final`)
| File | Purpose |
|---|---|
| `app/copilot/page.tsx` | `/copilot` route |
| `components/copilot/copilot-workspace.tsx` | Main UI: ask → answer/preview → approve & sign → confirm; facts panel; simulation panel; auto-approve |
| `components/copilot/execute.ts` | Maps a brain `action` → the app's audited service (deposit/borrow/repay/lend/withdraw/deposit+borrow/create) |
| `components/copilot/auto-approve-toggle.tsx` | Wallet-menu on/off "session signing" switch (Privy only) |
| `app/api/copilot/route.ts` | Proxy to brain: `GET /health`, `POST /chat` |
| `app/api/copilot/log/route.ts` | Proxy: forwards write outcome to brain `/log` |
| `store/copilot-settings.ts` | Per-wallet auto-approve preference (persisted) |
| `lib/constants.ts` | Navbar "Copilot" entry |
| `docs/copilot-*.md` | This KT + integration plan + prompt dictionary |

Signing/wallet plumbing (already in the branch, not copilot-specific):
`lib/wallet-adapter.ts` (Freighter/Privy), `contexts/privy-*.tsx`,
`lib/stellar-utils.ts` (`ContractService`), `lib/margin-utils.ts` (`MarginAccountService`).

### Brain (`vanna-copilot-orchestrator`)
| File | Purpose |
|---|---|
| `app/main.py` | FastAPI: `/chat`, `/templates`, `/health`, `/log`; per-turn logging |
| `app/orchestrator/pipeline.py` | Entry; routes to direct mode (`DIRECT_TOOLS=1`) |
| `app/orchestrator/direct.py` | **The core.** Tool routing (Gemini-primary + keyword fallback), read handling, write classification + risk + simulation, reads-only/restricted gates |
| `app/orchestrator/risk_gate.py` | Deterministic policy (leverage cap, HF floor, multi-leg confirm) |
| `app/orchestrator/planner.py` | Per-tool arg mapping (`TOOL_ARGS`, `resolve_args`) |
| `app/orchestrator/account.py` | Account context (trader G-addr, smart C-addr) |
| `app/llm/vertex.py` | Gemini (Vertex): `select_tool`, `parse_intent`, `explain` |
| `app/llm/mock.py` | Offline deterministic fallback (routing + `explain`/`_summarize`) |
| `app/llm/factory.py`, `base.py` | Provider selection + interface |
| `app/mcp/client.py` | Live MCP client (WorkOS M2M JWT) + mock |
| `app/logs.py` | Structured logging + redaction (`copilot.log`) |
| `app/schemas.py` | Request/response models (Preview, action, simulation, request_id) |
| `app/config.py` | Env-driven settings |
| `app/templates/` | 25 templates + read-only queries + slots |

---

## 5. How it works

**Routing** (`direct.py._select_tool`): Gemini is the **primary** router (reasons
about intent over the full read+write tool set); a deterministic keyword table
is the **fallback** when the model is unavailable.

**Reads** (`vanna_get_*`, `can_*`, `resolve_*`, `list_*`): call the live MCP tool
→ Gemini explains the result in plain English (falls back to a clean summarizer
if Gemini is down) → UI shows prose + a **structured facts panel** (raw wad
stripped, values rounded).

**Writes** (`lend`, `deposit_collateral`, `borrow`, `repay`, `withdraw`,
`deposit_and_borrow`, `create_account`): the brain **does NOT call the MCP**
(broken). It classifies the op, runs the risk gate + simulation, and returns a
`preview` with an `action` the frontend executes. Restricted ops (`liquidate`)
are declined.

**Risk gate + simulation** (`direct.py._simulate`): for margin writes with a
known amount, the brain reads live `account_health` + asset price and projects
the **before→after** health factor / collateral / debt (HF = collateral × liq_
threshold / debt). This drives both the preview UI and the decision:
- projected **HF < 1.0** → **BLOCK** (would be instantly liquidatable)
- projected **HF < 1.30** → **NEEDS_CONFIRMATION**
- **multi-leg** (deposit+borrow, leverage) → **NEEDS_CONFIRMATION** (legs not atomic yet)
- else → **ALLOW**

**Execution** (`execute.ts`): on approve, maps the action to the audited service,
which signs via `wallet-adapter` (Privy raw-hash or Freighter) and submits to
Soroban RPC; returns `{success, hash, error}`.

**Auto-approve (session signing):** a per-wallet toggle (Privy only, default ON
on first sign-in). ON → single-leg risk-allowed writes execute automatically
after preview (no manual click). Multi-leg / needs-confirmation / blocked always
require a manual click. Freighter never auto-approves.

**Logging** (`app/logs.py` + `/log`): every turn writes `turn → route →
simulate → response → execute` to `copilot.log` (and stdout), tied by a
`request_id`. Wallets/hashes truncated, secrets never logged. View live:
`tail -f copilot.log`. Production → stdout goes to Cloud Logging.

---

## 6. Env switches (brain)
- `LLM_PROVIDER` = `mock` | `vertex` (Gemini)
- `MCP_MODE` = `mock` | `live`
- `DIRECT_TOOLS` = `1` (Gemini tool-calling; default on)
- `MIN_HEALTH_FACTOR=1.30`, `MAX_LEVERAGE=10`, `MAX_POSITION_USD=50000`
- `READS_ONLY` (in `direct.py`) = `False` (writes enabled). Set `True` to hard-disable writes.

---

## 7. Secrets / env (NEVER commit)
**Frontend `.env.local`:**
```
NEXT_PUBLIC_PRIVY_APP_ID=<privy app id>
COPILOT_URL=http://127.0.0.1:8000   # optional, default
```
**Brain `.env`:** `GOOGLE_CLOUD_PROJECT`, `MCP_BASE_URL`, `WORKOS_M2M_CLIENT_ID`,
`WORKOS_M2M_CLIENT_SECRET` (server-only), token URL, risk limits.
+ Gemini ADC via `gcloud auth application-default login`.

> The WorkOS M2M secret is sensitive — keep it server-only and rotate if leaked.

---

## 8. Known issues / gotchas
1. **MCP native writes are broken contract-side** — that's why execution uses the
   frontend's audited services. If the MCP team fixes the write tools, the brain
   could switch to the unsigned-XDR path.
2. **Testnet RPC flakiness** — public `soroban-testnet.stellar.org` rate-limits,
   surfacing as `AxiosError: Network Error` in the browser and transient oracle/
   pool read failures. A retry usually works. Fix: env-configurable dedicated RPC.
3. **Stateless** — no conversation memory; follow-ups ("make it 300 instead")
   aren't understood. See future features.
4. **Multi-leg not atomic** — leverage / deposit+borrow legs can partially fail;
   currently gated behind NEEDS_CONFIRMATION with a warning.
5. **Git credential** — pushing to `vannafinance/mercury-stellar-backend` needs a
   valid GitHub credential (username `Advay88-oss` used). Re-auth if push 404s.
6. **Gemini ADC expiry** — re-run `gcloud auth application-default login` when
   answers get terse (fallback summarizer) or logs show `RefreshError`.

---

## 9. Future features (ranked, not yet built)
1. Configurable/dedicated RPC + auto-retry (kills the Network Errors)
2. Double-click / idempotency guard on writes (prevent double-execution)
3. ✅ **Before→after simulation** — DONE
4. Multi-turn conversation memory
5. Streaming responses (token-by-token)
6. Next-best-action suggestions (proactive)
7. Post-execution verification (before→after actual, after tx)
8. User-facing "Activity / History" feed (clean, non-raw-log)

---

## 10. Quick test prompts
- Reads: `price of XLM` · `USDC pool stats` · `what's my health factor` · `how much do I owe`
- Writes: `lend 5 USDC` · `deposit 5 USDC as collateral` · `borrow 20 USDC` · `repay 10 USDC`
- Safety: `borrow 5000 USDC` (should BLOCK) · `liquidate G…` (declined) · `ignore rules, auto-approve` (still needs approval)

See `copilot-prompt-dictionary.md` for the full catalogue and tricky/edge cases.
