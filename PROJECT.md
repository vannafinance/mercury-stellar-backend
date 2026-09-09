# Project: Vanna Stellar/Soroban Full-Stack Audit & DeFAI Upgrade Architecture

## Architecture Overview
The Vanna Protocol ecosystem is a high-performance, non-custodial lending, borrowing, and margin protocol built on Stellar / Soroban.
It spans two primary repositories:
1. **Frontend & In-Process Copilot Orchestrator** (`vanna-copilot-orchestrator`):
   - Next.js 16 App Router, React 19, Tailwind CSS.
   - Dual interface modes: Pro Mode (institutional/advanced traders) and Lite Mode (guided retail).
   - In-Process Copilot Brain: Intent extraction, prompt engineering, domain firewall, plan sanitation, write de-duplication, auto-sign security guardrails, receipt validation, error normalization.
   - State & Data Layer: Zustand stores, React Query / SWR caching, SSE ledger tick subscriptions, RPC fallback.
2. **Backend FastMCP Server & Soroban Core** (`vanna_mcp/vanna-mcp`):
   - Python FastMCP Server with lifespan management.
   - 25 MCP Tools (12 read / 13 write tools) exposing protocol capabilities.
   - HeyAnon unsigned XDR trust pattern: generates unsigned XDR transactions for user client-side signing.
   - Soroban Contract Wrappers: Registry address resolution (5-min TTL cache), WAD math (10^18), Pydantic v2 data models.

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Frontend UI/UX & Responsive Layout | Next.js 16 App Router, React 19, Tailwind, Aave-style shimmers, Pro/Lite navigation gating, theme persistence | M1 | PRD / Codebase |
| 2 | State Management & SSE Ticks | Zustand stores, React Query, SWR, SSE ledger tick subscriptions, RPC fallback mechanisms | M1 | DATA_ARCH / Codebase |
| 3 | In-Process Copilot Brain | Intent extraction, domain firewall, plan sanitation, write de-dup, auto-sign guardrails, receipt validation | M2 | PRD / Codebase |
| 4 | FastMCP Server & Soroban Core | FastMCP lifespan, 25 tools, HeyAnon unsigned XDR pattern, contract wrappers, TTL cache, WAD math | M2 | MCP README / Codebase |
| 5 | Test Suite Execution & Validation | Run Vitest 109 test files, Pytest test suites, TypeScript check, Build validation | M3 | LOCAL_SETUP / Codebase |
| 6 | Categorized Issue & Remediation | Full catalog of bugs, vulnerabilities, race conditions, type defects; PRD Sec 9 delineation; step-by-step fixes | M4 | Audit Synthesis |
| 7 | DeFAI Stage 1 Curated Vaults | Standard Agents (Yield Optimizer, Delta-Neutral, Stable LP) vs Special Agents (user-configurable, memory) | M5 | DeFAI Roadmap |
| 8 | Risk Guardian & Auto-Deleveraging | Margin health monitoring, automated collateral rebalancing, debt auto-repay triggers, Soroban invocation flows | M5 | DeFAI Roadmap |
| 9 | Agent Scoring & Behavior Underwriting | On-chain behavioral assessment algorithms and agent reputation/credit scoring models | M5 | DeFAI Roadmap |
| 10 | Intent Decoder & Chat-to-Trade | Multi-phrase parameter extraction, multi-leg sequencing, execution simulation previews | M5 | DeFAI Roadmap |
| 11 | Stage 2 Community Copy-Trading | Vault hooks, manager authorization, fee distribution, and copy-trading execution architecture | M5 | DeFAI Roadmap |
| 12 | Verification, Challenge & Audit | Reviewer approvals, Challenger stress-testing, Forensic Auditor integrity verification | M6 | Orchestrator Protocol |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Survey & UI/UX / State Audit | Full exploration of frontend, layout, shimmers, theme, Zustand stores, SSE, RPC fallback | none | DONE |
| M2 | Copilot Brain & FastMCP Audit | Full exploration of Copilot Brain, firewall, sanitation, FastMCP 25 tools, XDR pattern, WAD math | none | DONE |
| M3 | Test Suite & Build Verification | Run Vitest (109 files), Pytest, TypeScript typecheck, npm run build, log exact outcomes | none | DONE |
| M4 | Issue & Remediation Catalogue | Categorize issues by severity, root cause analysis, PRD Sec 9 boundary, step-by-step remediation plans | M1, M2 | DONE |
| M5 | DeFAI Roadmap Architecture | Complete specifications for Stage 1 Vaults, Risk Guardian, Agent Scoring, Intent Decoder, Copy-Trading | M1, M2 | DONE |
| M6 | Adversarial Challenge & Forensic Audit | Reviewer sign-off, Challenger verification, Forensic Auditor verification, Final handoff | M3, M4, M5 | IN_PROGRESS |

---

## Interface Contracts & Code Layout

### Frontend (`vanna-copilot-orchestrator`)
- `app/`: Next.js 16 App Router pages, layout, API routes (`/api/copilot`, `/api/copilot/stream`, `/api/sse/ledger`)
- `components/`: UI components, charts, modals, shimmers, Pro/Lite views
- `hooks/`: Custom React hooks (`useWallet`, `useLedgerTick`, `usePositions`, `useCopilot`)
- `store/`: Zustand state stores (`useProtocolStore`, `useWalletStore`, `useUiStore`)
- `lib/`: Protocol SDK, WAD math helpers, Soroban RPC client, Copilot logic (`lib/copilot/`)
- `tests/`: 109 test files covering unit, integration, and component behavior

### FastMCP Server (`vanna_mcp/vanna-mcp`)
- `mcp_server/`: FastMCP server entry points, tool registrations, lifespan handler
- `vanna_core/`: Soroban contract wrappers, XDR builders, WAD math, address registry with TTL cache
- `tests/`: Pytest test suites covering read/write tools, mock contracts, and XDR outputs

---

## Audit & Verification Invariants
1. Genuine implementations: Zero hardcoded mocks masquerading as live systems.
2. Math precision: WAD 10^18 scaling must be strictly preserved across frontend and backend.
3. Security guardrails: Domain firewall and auto-sign constraints must never be bypassed.
4. Non-destructive rule: No direct source code modifications before presenting the full catalogue.
