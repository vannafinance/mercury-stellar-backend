# Production readiness — Multi-leg copilot agent

**Branch:** `copilot-assistant`  
**Scope:** Multi-step strategy planning + sequential MCP execution + strategy UI card  
**Does not rewrite:** Vanna MCP server, Sign Service (use existing live services)

---

## What ships

| Layer | Change |
|-------|--------|
| Planner | Multi-goal keyword + Vertex merge; HF floors never become amounts |
| Runner | `MultiLegAgent` expands levered farm → deposit/borrow/supply; HF stop |
| MCP client | Session reuse; human network/timeout errors |
| API | `maxDuration = 300` for long multi-leg turns |
| UI | Strategy card (no red wall of text / internal facts dump) |
| Wallet | Privy “Create Vanna wallet” copy + create toast |

---

## Pre-deploy checklist

### Environment (production host)

- [ ] `MCP_MODE=live`
- [ ] `MCP_BASE_URL` points at production MCP (`https://mcp.vanna.finance/mcp` or current prod)
- [ ] `WORKOS_M2M_CLIENT_ID` / `SECRET` / `TOKEN_URL` valid for that MCP
- [ ] Vertex: `GOOGLE_CLOUD_PROJECT`, `VERTEX_MODEL`, host can mint Google tokens (ADC or workload identity)
- [ ] `COPILOT_READS_ONLY=false` only if writes are intended
- [ ] Optional: `COPILOT_MULTI_LEG_MAX=8` (default)
- [ ] Optional: `COPILOT_LOG=1` if you want turn logs outside production default
- [ ] Host honors **≥ 300s** request timeout for `/api/copilot` (or multi-leg will abort mid-chain)

### Sign Service / MCP

- [ ] Auto-sign policy allows deposit / borrow / Blend supply (Deposit decode deployed)
- [ ] Testnet vs mainnet env explicit — do not point UI at testnet MCP with mainnet wallets by mistake

### Regression smoke (manual, staging or prod canary)

1. **Single write:** `deposit 5 XLM as collateral` → still works  
2. **Read:** `what is my health factor` → still works  
3. **Multi-leg (auto-sign on):**  
   `park 20 XLM for yield then farm 10 BLUSDC at 2x keep HF above 1.4`  
   → strategy card, 4 legs, real hashes on Done steps  
4. **Multi-leg auto-sign off:** pauses cleanly; no false “all done”  
5. **MCP down:** card shows network reason; later legs Skipped  

### Automated

```bash
npm run test:multi-leg
# or full suite
npm test
```

---

## Production safety properties

1. **Blast radius:** Multi-leg only when router emits `kind: "plan"`. Single ops unchanged.  
2. **Honest partials:** Fail → stop; later legs never marked Done.  
3. **No invented hashes:** Only MCP/Sign Service return values.  
4. **Risk still per-leg:** Each write goes through MCP + Sign Service.  
5. **Cap:** `COPILOT_MULTI_LEG_MAX` bounds legs (default 8).  

### Residual risks (accept or monitor)

| Risk | Mitigation |
|------|------------|
| Partial position if leg 2 fails after leg 1 | Honest card; user can repay/continue manually |
| Long latency / host timeout | `maxDuration=300`; keep max legs low |
| Free-form strategies outside park/farm patterns | Keyword + Vertex help; not unlimited agent |
| MCP cold starts | Session reuse + clearer retry errors |

---

## Wallet create: what’s done vs MCP

| Feature | Where | Status |
|---------|--------|--------|
| Create **G-wallet** (Privy email/Google) | App: `PrivyWalletBridge` + Connect modal | **Done** (create-on-login + toast) |
| Freighter connect | App wallet adapter | Existing |
| Open **margin C-account** | MCP `vanna_account` action `open` / copilot `create_account` | **MCP exists** — use “open margin account” in copilot |
| MCP tool `create_wallet` for Privy | vanna-mcp server | **Not required / not implemented** — wallet is client-side |

Multi-leg does **not** need a new MCP wallet-create tool. MCP must stay up for lend/deposit/borrow/swap/supply.

---

## GCP deploy (existing project — no new project)

Deploy **this Next app** (copilot brain) to the **existing** Cloud Run service. Owner/ops with deploy rights:

```bash
# From repo root (branch copilot-assistant or merged main)
export PROJECT=vanna-mcp          # or your existing project id
export REGION=us-central1         # match current service region
export SERVICE=vanna-app          # match existing Cloud Run service name

gcloud config set project $PROJECT

# Build + deploy from source (Cloud Build)
gcloud run deploy $SERVICE \
  --project=$PROJECT \
  --region=$REGION \
  --source=. \
  --platform=managed \
  --allow-unauthenticated \
  --timeout=300 \
  --cpu=2 \
  --memory=2Gi \
  --set-env-vars="MCP_MODE=live,MCP_BASE_URL=https://mcp.vanna.finance/mcp,COPILOT_READS_ONLY=false"

# Ensure secrets already attached on the service (do not recreate project):
# WORKOS_M2M_CLIENT_ID, WORKOS_M2M_CLIENT_SECRET, WORKOS_M2M_TOKEN_URL,
# GOOGLE_CLOUD_PROJECT / Vertex SA, NEXT_PUBLIC_PRIVY_APP_ID (build-time if needed)
```

**MCP server** (separate if you redeploy MCP, not required for multi-leg copilot code):

```bash
# Only if MCP code changed — example shape; use your real MCP service name
export MCP_SERVICE=vanna-mcp
gcloud run deploy $MCP_SERVICE \
  --project=$PROJECT \
  --region=$REGION \
  --source=. \
  --timeout=300
```

Multi-leg readiness on MCP: existing tools + Sign Service Blend deposit decode. No MCP multi-leg tool.

---

## Rollout recommendation

1. **Staging** full multi-leg with auto-sign + real SA  
2. **Canary** production behind same branch / gradual traffic  
3. **Monitor** `[copilot]` logs: `multi_leg`, `multi_leg_steps`, `execution`, `kind`  
4. **Rollback:** revert deploy of this app only — MCP/Sign Service independent  

---

## CTO one-liner

> Multi-leg strategies (park → levered farm) run as ordered MCP legs with a structured strategy UI, HF floor stops, and no false completion claims. Ready for production after env + staging smoke; not a free-form autonomous agent rewrite.

---

## Out of scope (later)

- Full free-form any-strategy agent  
- MCP protocol rewrite  
- Deep Privy recovery / export UX beyond create-and-save  
