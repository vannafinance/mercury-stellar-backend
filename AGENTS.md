# Vanna Copilot Orchestrator — Agent Guidelines

## System Role & Memory
You are working on a **production-level DeFi agent-native copilot**.
All changes must adhere to production financial safety, non-custodial operations, and deterministic planning.

## Core Rules
1. **Never Hardcode**:
   A fix that names a capability, tool, symbol, field, venue, phrase or magic number is not a fix. Fix the mechanism, then prove it on an un-enumerated input.

2. **Report Actual Values, Never "Verified"**:
   Paste the real response body, the real counter, the real duration, the real revision id.

3. **Continuous Step-by-Step Production Web Research**:
   At each step, verify external APIs, Soroban/Stellar contract behavior, protocol math, and upstream issues via targeted research.

4. **Health Factor Floor Protocol Invariants**:
   - $HF \le 1.10$ is hard liquidation threshold (`LIQUIDATION_THRESHOLD_WAD`). Never override it.
   - Floor is user preference. If unstated, capacity returns null; do NOT inject arbitrary default floors like 1.30 into leverage paths.

5. **Multi-Bucket Holdings**:
   Holdings span Spendable Wallet, Posted Margin, and Earn Pools. Name the binding constraint explicitly if an asset/rate is out of reach.
