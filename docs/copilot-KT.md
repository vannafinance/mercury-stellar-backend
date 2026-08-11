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

## 2. Architecture (one repo, one process)

```
┌──────────────┐  POST /api/copilot  ┌─────────────────────┐   Gemini + MCP   ┌───────────┐
│ /copilot UI  │ ──────────────────► │  brain (lib/copilot)│ ───────────────► │ vanna-mcp │
│ Next.js      │ ◄────────────────── │  in the same server │ ◄─────────────── │ (14 tools)│
└──────┬───────┘  answer / preview   └─────────────────────┘  data · build ·  └───────────┘
       │                                                       auto-sign attempt
       │ preview carries MCP's unsigned_xdr
       ▼  wallet signs THAT envelope → Soroban RPC → poll → confirm
   on-chain
```

The UI, the API route, and the brain all live in this repo and this process.
There is no second service to run.

**Where the transaction is built:** the MCP server. It resolves the contract
addresses, simulates, and assembles the Soroban footprint, then returns an
`unsigned_xdr`. Two things can happen next:

1. **Auto-sign** — MCP asks the Vanna Sign Service to sign and submit. Works only
   when the Sign Service can see a user-scoped identity (see §8.1).
2. **Wallet sign** — the copilot hands the *same* envelope to the browser, the
   user's wallet signs it, and the app submits it to Soroban RPC.

Either way the brain never holds a key. `components/copilot/execute.ts` (the old
"rebuild it locally through the app's audited services" path) is now only a
fallback for turns that return no XDR.

---

## 3. How to run

**Single process** (recommended — brain is in-process inside Next.js):
```bash
npm install
# .env.local with WorkOS M2M + MCP_MODE=live (see §7)
npm run dev
```
- Open `http://localhost:3000/copilot`.
- Health: `GET http://localhost:3000/api/copilot` → `{ health: { status, llm_provider, mcp_mode, templates, in_process: true } }`.
- No uvicorn / port 8000. Implementation: `lib/copilot/*` + `app/api/copilot/route.ts`.

**Legacy Python brain** (optional / historical):
```bash
# only if you still have the separate FastAPI package checked out
.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
# then set COPILOT_URL — not used by the current in-process path
```

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

### Brain — in-process TypeScript (`lib/copilot/*`)

The Python FastAPI brain is retired. Everything below runs inside the Next.js
server process; there is no uvicorn and no `COPILOT_URL`.

| File | Purpose |
|---|---|
| `lib/copilot/handle.ts` | **The core.** `handleChat` — routing, read handling, write execution, auto-sign actions, multi-step plans |
| `lib/copilot/router.ts` | Deterministic keyword router (fallback when Vertex is down) |
| `lib/copilot/vertex.ts` | Gemini (Vertex): `vertexSelectTool`, `vertexExplain`, `vertexPing` |
| `lib/copilot/mcp-client.ts` | Live MCP client (WorkOS M2M JWT, Streamable HTTP + SSE) + mock client |
| `lib/copilot/mcp-write.ts` | Maps a write op → MCP tool, then interprets the auto-sign outcome |
| `lib/copilot/tool-args.ts` | Per-tool argument mapping + smart-account requirements |
| `lib/copilot/risk.ts` | Informational before→after projection (display only) |
| `lib/copilot/explain.ts` | Fallback summarizer + `factsForUi` |
| `lib/copilot/types.ts`, `config.ts`, `log.ts` | Response models, env config, structured logging |

> ⚠️ `lib/copilot/`, `tests/copilot-brain.test.ts` and `docs/ONBOARDING_COPILOT.md`
> are **untracked** at the time of writing — commit them before any `git clean`.

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
1. **Auto-sign cannot work with an M2M token alone.** MCP builds and simulates
   writes fine (`sim ok` / `xdr ready`), then the Sign Service rejects the
   signature request with `invalid_user_assertion` / "Invalid token audience".
   The copilot server authenticates to WorkOS with **client_credentials**, which
   proves the *app's* identity, not the user's. The Sign Service wants a
   **user-scoped** token (a user assertion) before it will sign for a wallet.
   Until that identity is plumbed through — the user authenticating against
   AuthKit in the browser and the copilot forwarding that user access token to
   MCP — every write lands in `needs_wallet_sign` and the user signs it
   themselves. That path is fully working and is not a degraded mode.

   **The signature goes on the XDR MCP built** (`components/copilot/sign-xdr.ts`),
   not on a locally rebuilt transaction. Rebuilding was the old behaviour and it
   re-ran the app's Registry/collateral pre-flight, which is where the misleading
   "XLM token contract address needs to be set in the Registry contract" and
   "Failed to get user address" toasts came from — MCP had already simulated the
   very same call successfully. `execute.ts` remains only as a fallback for turns
   that return no XDR.
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
