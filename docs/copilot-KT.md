# Vanna Copilot — Master Knowledge Transfer (KT) Document

> **Target Audience:** Engineers, Architects, and Technical Leads inheriting, maintaining, or expanding the Vanna Copilot Orchestrator.

---

## 1. Executive Summary & Core Mission

Vanna Copilot is an **agentic, non-custodial DeFi orchestrator** embedded inside the Vanna web application (`/copilot`). It translates free-form user intents (*"park 20 XLM then farm 10 BLUSDC at 2x leverage keeping my HF above 1.4"*) into safe, simulated, multi-step transaction plans on Stellar (Soroban testnet).

### Core Architectural Axiom:
$$\textbf{The LLM reasons and plans} \iff \textbf{Deterministic code \& Smart Contracts govern funds}$$
* The server **never holds private keys**.
* Prompt injection cannot move funds; all execution boundaries (amounts, token addresses, leverage caps, risk simulations, cryptographic signatures, and spend policies) are strictly controlled by non-model deterministic code.

---

## 2. System Architecture & Component Interaction

```
┌───────────────────────────┐      POST /api/copilot       ┌─────────────────────────────────────┐
│   Vanna Web Frontend      │ ───────────────────────────► │  Copilot Brain (lib/copilot/)       │
│   (/copilot React UI)     │ ◄─────────────────────────── │  In-Process Next.js Server Route    │
└─────────────┬─────────────┘      Plan Preview / Answer   └───────────┬─────────────────────┬───┘
              │                                                        │                     │
              │ Browser Wallet Sign (Privy / Freighter)                │ Vertex API (Gemini) │ MCP JSON-RPC
              ▼                                                        ▼                     ▼
┌───────────────────────────┐                              ┌─────────────────┐   ┌───────────────────┐
│     Stellar Network       │ ◄─────────────────────────── │ Google Cloud    │   │ Vanna MCP Server  │
│   (Soroban Smart RPC)     │   On-Chain Transaction Exec  │ Vertex AI       │   │ (14 Live Tools)   │
└───────────────────────────┘                              │ (gemini-3.7-fl) │   └─────────┬─────────┘
                                                           └─────────────────┘             │ Auto-Sign
                                                                                           ▼
                                                                                 ┌───────────────────┐
                                                                                 │ Vanna Sign Service│
                                                                                 │ (Spend Cap Policy)│
                                                                                 └───────────────────┘
```

---

## 3. End-to-End Request Lifecycle

1. **Edge Ingestion & Domain Firewall (`lib/copilot/domain-firewall.ts`):**
   * Pre-screens user prompt. Off-domain requests (coding, homework, math, life advice, prompt injection) are blocked with **0 Gemini tokens billed**.
   * Valid Vanna domain operations, assets, protocol reads, and screen context pass through in 0ms.
2. **Intent Classification & Routing (`lib/copilot/router.ts` & `vertex.ts`):**
   * Simple single-leg queries (*"lend 10 XLM"*, *"what is my health factor"*) use fast keyword deterministic matching.
   * Multi-leg complex strategies (*"swap X to Y then farm Z"*) use **Gemini 3.7 Flash** (`gemini-3.7-flash`) via Google Cloud Vertex AI with native Function Calling.
3. **Deterministic Step Extraction & Plan IR (`lib/copilot/step-extractor.ts`):**
   * Converts the intent into an Intermediate Representation (IR) containing explicit operations, assets, amounts, fractions, and leverage slots.
4. **Risk Gate & Margin Simulation (`lib/copilot/risk.ts`):**
   * Simulates pre-op and post-op collateral, debt, and Health Factor. Hard-blocks operations if projected $\text{HF} < 1.00$, if user HF floor is breached, or position $> \$50,000$.
5. **Plan Freeze & Fingerprinting (`lib/copilot/plan-approval.ts`):**
   * Hashes all executable slots with SHA-256 (`plan_id`) and displays an approval preview card to the user.
6. **Execution & Idempotency Locking (`lib/copilot/handle.ts` & `write-dedupe.ts`):**
   * When user clicks "Approve Strategy", atomic server-side lock prevents duplicate execution within a 15-second window.
   * If Auto-Sign is enabled on the Sign Service, MCP submits on-chain; otherwise, the unsigned XDR envelope is returned to the user's browser wallet for manual signature.

---

## 4. Authentication & Identity Architecture

The Copilot handles two distinct types of credentials simultaneously:
* **M2M Transport Credential (WorkOS):** Proves the Next.js server's identity when talking to the backend MCP server.
* **User-Scoped Identity Assertion (Privy JWT):** Proves the end-user's identity (`did:privy:...`) so that the Sign Service can enforce personal auto-sign spend caps without cross-user privilege escalation.

---

## 5. Configuration & Environment Variables

| Environment Variable | Recommended Setting | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `vertex` | Uses Google Cloud Vertex AI. |
| `GOOGLE_CLOUD_PROJECT` | `vanna-mcp` | GCP project ID hosting Vertex AI. |
| `GOOGLE_CLOUD_LOCATION` | `global` | Multi-region global endpoint. |
| `VERTEX_MODEL` | `gemini-3.7-flash` | Primary Foundation Model. |
| `MCP_MODE` | `live` | Connects to production/staging MCP server. |
| `MCP_BASE_URL` | `https://mcp.vanna.finance/mcp` | MCP endpoint URL. |
| `NEXT_PUBLIC_PRIVY_APP_ID`| *(Public Privy App ID)* | Enables embedded wallets and user assertions. |
| `COPILOT_READS_ONLY` | `false` (or `true` for testing) | Safety kill switch to disable all on-chain writes. |
| `COPILOT_LOG` | `1` | Enables verbose structured event logging. |

---

## 6. Testing & Quality Assurance

### Key Test Commands:
```bash
# Run all unit and integration tests (1,150+ tests)
npm test

# Run multi-leg strategy and firewall test suites
npm run test:multi-leg

# Run domain firewall test suite
npx vitest run tests/lib/domain-firewall.test.ts

# Type-check TypeScript codebase
npx tsc --noEmit
```

---

## 7. Troubleshooting & Gotchas

1. **Turbopack Dev Memory Ceiling:**
   * Dev server sits at ~3.2 GB RSS. Always start with: `NODE_OPTIONS=--max-old-space-size=6144 npm run dev`.
2. **Never Run Two `next dev` Processes:**
   * Two concurrent instances will corrupt `.next` build cache and cause 500 errors.
3. **Transient Testnet RPC Flukes:**
   * If a single integration test returns `RPC down`, re-run the test suite before assuming code regression.
4. **Auto-Sign Single Writes:**
   * Single writes execute immediately when Auto-Sign is active. Always set `COPILOT_READS_ONLY=true` before running automated test matrices on production accounts.
