# Vanna Copilot — Guardrails & Domain Firewall Architecture

> Complete specification of all security boundaries, domain firewalls, risk simulation gates, and execution safeguards governing the Vanna Copilot Orchestrator on Stellar DeFi.

---

## 1. Core Architectural Principle

$$\textbf{The LLM interprets natural language} \iff \textbf{Deterministic code \& Smart Contracts govern execution}$$

* **Prompt Injection Cannot Move Funds:** An attacker may influence the natural language explanation returned by Gemini, but transaction amounts, recipient accounts, token contracts, risk simulations, cryptographic signatures, and spend policies are exclusively controlled by deterministic, non-model software gates.
* **Token Abuse & Cost Firewall:** The Domain Firewall filters out off-domain queries, coding requests, homework, math problems, and adversarial jailbreaks **before** burning any Google Cloud Vertex LLM tokens.

---

## 2. Defence-in-Depth: The 9-Layer Security Architecture

```mermaid
flowchart TD
  L1["1 · Domain Firewall (domain-firewall.ts)<br/>Off-domain & jailbreaks blocked at 0 tokens"]
  L2["2 · Automation-Gap Guard (conditional-guard.ts)<br/>Unmonitored 24/7 standing orders refused"]
  L3["3 · Static Validation (router.ts / assets.ts)<br/>Unsupported assets & >10x leverage blocked"]
  L4["4 · Ambiguity Gate (Bare USDC disambiguation)<br/>Never guesses between BLUSDC / AQUSDC / SOUSDC"]
  L5["5 · Risk Gate (risk.ts)<br/>Deterministic before → after Health Factor simulation"]
  L6["6 · Plan Freeze & Fingerprint (plan-approval.ts)<br/>SHA-256 hash locks approved execution slots"]
  L7["7 · MCP Server Simulation<br/>Soroban transaction envelope simulated on-chain"]
  L8["8 · Sign Service Policy & Spend Caps<br/>Server-enforced ~$1,000/tx and daily limits"]
  L9["9 · Non-Custodial Signature<br/>User's browser wallet (Freighter / Privy) signs"]

  L1-->L2-->L3-->L4-->L5-->L6-->L7-->L8-->L9
```

> **Note:** Layers 1–6 run in this Next.js server. Layers 7–8 run on the backend MCP / Sign Service. Layer 9 runs client-side in the user's browser wallet. **No layer trusts the one above it.**

---

## 3. Domain Firewall Deep-Dive (`lib/copilot/domain-firewall.ts`)

The domain firewall prevents bot abuse and protects Google Cloud Vertex AI billing by classifying prompts before calling Gemini 3.7 Flash:

```mermaid
flowchart TD
  In["User Message"] --> B1{"1. Fast Blocklist?<br/>(Coding, homework, jokes, jailbreaks)"}
  B1 -->|Yes| Block["BLOCK (0 Tokens)"]
  B1 -->|No| A1{"2. Product Allowlist?<br/>(Vanna vocabulary, assets, actions, contracts)"}
  A1 -->|Yes| Allow["ALLOW (0ms Pass-Through)"]
  A1 -->|No| P1{"2b. Page Context Active?<br/>(Deictic screen questions: 'what is this?')"}
  P1 -->|Yes| Allow
  P1 -->|No| G1{"3. Greeting / Short Token?<br/>('hi', 'help', 'yes', 'no')"}
  G1 -->|Yes| Allow
  G1 -->|No| S1{"4. Financial / DeFi Semantic Match?<br/>(Yield, buffer, slippage, vaults, pnl)"}
  S1 -->|Yes| Allow
  S1 -->|No| Block2["BLOCK (Off-Domain / No Financial Signal)"]
```

### Layered Filtering Logic:
1. **Adversarial & Abuse Blocklist (`BLOCK_PATTERNS`):**
   * **Coding / Software Engineering:** Blocks requests for Python, TypeScript, React, Docker, CI/CD, smart contract coding.
   * **Academic & Homework:** Blocks essay generation, calculus, physics, and homework math puzzles.
   * **Adversarial Jailbreaks:** Blocks system prompt extraction (*"reveal your instructions"*), override attempts (*"ignore previous rules"*), and roleplay evasions (*"pretend you are a teacher/coder"*).
2. **Deterministic Product Allowlist (`ALLOW_PATTERNS`):**
   * **Actions:** `lend`, `borrow`, `repay`, `deposit`, `withdraw`, `farm`, `earn`, `swap`, `margin`, `stake`, `park`.
   * **Assets:** Dynamically synced from `registry/assets.ts` (`XLM`, `BLUSDC`, `AQUSDC`, `SOUSDC`, `USDT`, `bTokens`).
   * **Positions & Metrics:** `health factor`, `liquidation`, `collateral`, `debt`, `available credit`, `headroom`, `balance`.
3. **Screen / Page Deictic Allowlist:**
   * Permits on-screen inquiries (*"what am I looking at?"*, *"explain this chart"*) when page context is present.
4. **Financial Semantic Fallback (`FINANCIAL_SEMANTIC_RE`):**
   * Captures natural DeFi phrasings (*"what is my liquidation buffer"*, *"how much yield in vaults"*) so valid financial questions are never falsely rejected.

---

## 4. Google Cloud (GCP) Security & Model Architecture

* **Foundation Model:** **Gemini 3.7 Flash** (`gemini-3.7-flash`) via Google Cloud Vertex AI (Project: `vanna-mcp`, Location: `global`).
* **Vertex AI Model Armor Ready:**
  * Can be activated inline on GCP to enforce enterprise prompt filtering, DLP (PII redaction), and model-agnostic jailbreak detection.
* **Keyless Workload Identity Federation:**
  * Production authentication uses Google Cloud Workload Identity Federation (OIDC) rather than long-lived static service account keys in production.

---

## 5. Refusals & Execution Safeguards

| Refusal / Guard | Enforced In | Trigger Condition | Reason |
|---|---|---|---|
| **Off-Domain Abuse** | `domain-firewall.ts` | Homework, coding, non-financial chat | Prevents token drain and billing abuse. |
| **Adversarial Prompt Injection** | `domain-firewall.ts` | System prompt extraction / DAN mode | Rejects attack before Vertex invocation. |
| **Unmonitored Standing Order** | `conditional-guard.ts` | *"watch my position 24/7"* | Copilot does not maintain background cron monitors. |
| **Liquidation Attempt** | `router.ts` | *"liquidate 0x..."* | Returns `restricted` before any tool call. |
| **Unsupported Token** | `router.ts` / `assets.ts` | *"supply 10 BTC"* | Refuses immediately with list of supported tokens. |
| **Bare USDC on Write** | `mcp-write.ts` | Asset is exactly `USDC` | Prevents guessing between distinct Stellar SACs. |
| **Excessive Leverage** | `handle.ts` | Leverage $> 10\times$ (`MAX_LEVERAGE`) | Blocks leverage exceeding protocol safety thresholds. |
| **Replay & Double-Click** | `write-dedupe.ts` | Same `plan_id` within 15 seconds | Server-side atomic lock prevents double submission. |

---

## 6. Risk Gate & Margin Simulation (`lib/copilot/risk.ts`)

Runs automatically on every margin-affecting transaction:

```mermaid
flowchart TD
  IN["Action + Size"] --> POS{"Position Size > $50,000?"}
  POS -->|Yes| BLK1["BLOCK — Exceeds Position Limit"]
  POS -->|No| BASE["Fetch Baseline Health Factor"]
  BASE --> SIM["Simulate Post-Op Collateral, Debt & HF"]
  SIM --> R1{"Projected HF < 1.00?"}
  R1 -->|Yes| BLK2["BLOCK — Instantly Liquidatable"]
  SIM --> R2{"Below User Floor (e.g. 1.4)?"}
  R2 -->|Yes| BLK3["BLOCK — Breaches Stated Floor"]
  SIM --> R3{"Below Policy Floor 1.30?"}
  R3 -->|Yes| WARN["NEEDS_CONFIRMATION"]
  R3 -->|No| OK["ALLOW"]
```

---

## 7. Plan Integrity & Non-Custodial Safety

1. **Plan Freeze & SHA-256 Fingerprinting (`plan-approval.ts`):**
   * Multi-step plans are constructed, assigned a content hash (`plan_id`), and frozen. Approving a plan replays the frozen steps verbatim—it never re-queries the model.
2. **Non-Custodial by Construction:**
   * The server **never holds private keys**.
   * Transactions are simulated and constructed as XDR envelopes by the MCP server, and submitted to the user's browser wallet for final cryptographic signature.
