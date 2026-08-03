// Oracle/agent monitoring fixtures, Stellar-native edition.
//
// All names, asset symbols, and protocol references must match the
// Soroban deployment (RiskEngine + OracleContract + LendingProtocol_*
// + tracking-token contracts). Anything EVM (Chainlink/Pyth/dYdX/GMX/
// Uniswap, vETH/vBTC perp tickers) is replaced by its Stellar equivalent
// (Reflector + Blend/Aquarius/Soroswap, BLEND_XLM/AQ_XLM_USDC/SS_XLM_USDC).

import type {
  AlertEvent,
  AlertSeverity,
  MonitoringAgent,
  OracleHealth,
  OracleStatus,
} from "./types";
import { syntheticGAccount, shortStellar } from "@/lib/analytics/stellar/canon";

let alertCounter = 0;

function uid(): string {
  return `alert-${Date.now()}-${++alertCounter}`;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function drift(value: number, range: number, min: number, max: number): number {
  const delta = (Math.random() - 0.5) * 2 * range;
  return clamp(value + delta, min, max);
}

const ALERT_MESSAGES: Record<string, string[]> = {
  "liquidation-guard": [
    "SmartAccount health factor dropped below 1.10 — liquidation path triggered (AccountManager.liquidate)",
    "Liquidation attempt failed — Soroban resource limit hit, retrying with reduced footprint",
    "Slippage estimate 8.2% for AQ_XLM_USDC LP collateral liquidation",
    "No liquidator response in 45s — escalating to Risk Engine pause",
  ],
  "track-token-verifier": [
    "BLEND_USDC tracking token deviation spiked to 2.8% temporarily",
    "AQ_XLM_USDC LP IL causing 3.1% value gap vs Aquarius pool quote",
    "Cross-check passed — all tracking tokens within deviation threshold",
    "SS_XLM_USDC basis spread vs Soroswap pool widened to 1.2%",
  ],
  "oracle-watcher": [
    "BLUSDC Reflector feed stale — freshness exceeds 60s",
    "XLM Reflector heartbeat healthy — 12s",
    "AQUSDC oracle deviation between Reflector pushes: 0.3%",
    "New borrows paused for BLUSDC — Risk Engine staleness guard tripped",
  ],
  "liquidity-stress": [
    "Stress test passed — insurance covers 1.74x worst-case shortfall",
    "Warning: 30% XLM crash scenario would exceed insurance by $70K",
    "Hourly simulation complete — 2 of 3 scenarios passing",
  ],
  "protocol-monitor": [
    "Blend pool TVL stable — $90M (+0.2%)",
    "Aquarius scheduled fee-tier update detected — monitoring",
    "Soroswap XLM/USDC pool depth adequate for liquidations",
  ],
  "correlation-risk": [
    "XLM-correlated positions now 42% of pool — approaching 45% threshold",
    "Concentration alert: 3 whale G-accounts hold 28% of total borrows",
    "Cross-asset correlation within acceptable range",
  ],
};

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function maybeSeverity(): AlertSeverity {
  const r = Math.random();
  if (r < 0.15) return "critical";
  if (r < 0.5) return "warning";
  return "info";
}

export function createOracleAgentsInitialState(): {
  oracles: OracleHealth[];
  agents: MonitoringAgent[];
  alerts: AlertEvent[];
  lastUpdated: number;
} {
  const now = Date.now();

  // Stellar oracle wrappers from `lib/analytics/stellar/canon.ts → ORACLE`
  // — Reflector is the only price source on Soroban.
  const oracles: OracleHealth[] = [
    {
      asset: "XLM",
      source: "Reflector",
      lastUpdateTimestamp: now - 12_000,
      freshnessSeconds: 12,
      status: "healthy",
    },
    {
      asset: "USDC",
      source: "Reflector",
      lastUpdateTimestamp: now - 8_000,
      freshnessSeconds: 8,
      status: "healthy",
    },
    {
      asset: "AQUSDC",
      source: "Reflector",
      lastUpdateTimestamp: now - 47_000,
      freshnessSeconds: 47,
      status: "warning",
    },
    {
      asset: "SOUSDC",
      source: "Reflector",
      lastUpdateTimestamp: now - 14_000,
      freshnessSeconds: 14,
      status: "healthy",
    },
  ];

  const agents: MonitoringAgent[] = [
    {
      id: "liquidation-guard",
      name: "Liquidation Guard Agent",
      description:
        "Scans every SmartAccount each ledger close (~5s). Calls AccountManager.liquidate when HF < 1.10. Alerts if no liquidator responds in 60s.",
      status: "Running",
      lastCheck: now - 3_000,
      alertCount: 2,
      interval: "15s",
    },
    {
      id: "track-token-verifier",
      name: "Track Token Verifier",
      description:
        "Cross-checks Vanna tracking tokens (BLEND_*, AQ_*, SS_*) vs the underlying Blend/Aquarius/Soroswap pool quote. Flags deviation >2%.",
      status: "Running",
      lastCheck: now - 12_000,
      alertCount: 1,
      interval: "30s",
    },
    {
      id: "oracle-watcher",
      name: "Reflector Staleness Watcher",
      description:
        "Monitors all Reflector feeds proxied through OracleContract. Pauses new borrows if any critical oracle is stale >60s.",
      status: "Warning",
      lastCheck: now - 5_000,
      alertCount: 3,
      interval: "10s",
    },
    {
      id: "liquidity-stress",
      name: "Liquidity Stress Agent",
      description:
        "Runs simulation: if top 10 borrowers default, does insurance cover the shortfall? Hourly.",
      status: "Running",
      lastCheck: now - 1_800_000,
      alertCount: 0,
      interval: "1h",
    },
    {
      id: "protocol-monitor",
      name: "Integrated Protocol Monitor",
      description:
        "Pings Blend / Aquarius / Soroswap contracts every 30s. Alerts if any pool TVL drops >15% suddenly.",
      status: "Running",
      lastCheck: now - 15_000,
      alertCount: 0,
      interval: "30s",
    },
    {
      id: "correlation-risk",
      name: "Correlation Risk Agent",
      description:
        "Detects when multiple large SmartAccounts hold correlated XLM-denominated collateral. Triggers concentration alert.",
      status: "Running",
      lastCheck: now - 60_000,
      alertCount: 1,
      interval: "5m",
    },
  ];

  // Reuse a deterministic Stellar G-account for the example liquidation alert
  // so it renders as a 56-char base32 short form (G…), never as `0x…`.
  const exampleAccount = shortStellar(syntheticGAccount(0xa1b));

  const alerts: AlertEvent[] = [
    {
      id: "init-1",
      agentId: "oracle-watcher",
      agentName: "Reflector Staleness Watcher",
      severity: "warning",
      message: "AQUSDC Reflector freshness exceeds 30s threshold (47s)",
      timestamp: now - 20_000,
      acknowledged: false,
    },
    {
      id: "init-2",
      agentId: "track-token-verifier",
      agentName: "Track Token Verifier",
      severity: "critical",
      message: "AQ_XLM_USDC tracking token deviation at 4.3% — exceeds 2% threshold",
      timestamp: now - 45_000,
      acknowledged: false,
    },
    {
      id: "init-3",
      agentId: "liquidation-guard",
      agentName: "Liquidation Guard Agent",
      severity: "warning",
      message: `SmartAccount ${exampleAccount} health factor at 1.08 — liquidation imminent`,
      timestamp: now - 120_000,
      acknowledged: false,
    },
  ];

  return { oracles, agents, alerts, lastUpdated: now };
}

export function simulateOracleAgentsTick(state: {
  oracles: OracleHealth[];
  agents: MonitoringAgent[];
  alerts: AlertEvent[];
}): {
  oracles: OracleHealth[];
  agents: MonitoringAgent[];
  alerts: AlertEvent[];
  lastUpdated: number;
} {
  const now = Date.now();

  const oracles = state.oracles.map((o) => {
    const reset = Math.random() < 0.2;
    const freshness = reset
      ? Math.floor(Math.random() * 5) + 1
      : o.freshnessSeconds + 3;
    const status: OracleStatus =
      freshness > 60 ? "stale" : freshness > 30 ? "warning" : "healthy";
    return {
      ...o,
      freshnessSeconds: freshness,
      lastUpdateTimestamp: reset ? now : o.lastUpdateTimestamp,
      status,
    };
  });

  const newAlerts: AlertEvent[] = [];
  const agents = state.agents.map((a) => {
    const shouldAlert = Math.random() < 0.05;
    if (shouldAlert) {
      const msgs = ALERT_MESSAGES[a.id] ?? ["Agent check completed"];
      newAlerts.push({
        id: uid(),
        agentId: a.id,
        agentName: a.name,
        severity: maybeSeverity(),
        message: pickRandom(msgs),
        timestamp: now,
        acknowledged: false,
      });
    }
    const agentStatus =
      a.id === "oracle-watcher" && oracles.some((o) => o.status === "stale")
        ? ("Warning" as const)
        : a.id === "oracle-watcher" && oracles.some((o) => o.status === "warning")
          ? ("Warning" as const)
          : a.status === "Error"
            ? ("Error" as const)
            : ("Running" as const);
    return {
      ...a,
      lastCheck: now,
      status: agentStatus,
      alertCount: a.alertCount + (shouldAlert ? 1 : 0),
    };
  });

  const alerts = [...newAlerts, ...state.alerts].slice(0, 50);

  return { oracles, agents, alerts, lastUpdated: now };
}

// `drift` is currently used to evolve future numeric metrics in the agents
// dashboard. Keep it exported via internal use to avoid TS6133 if/when it's
// referenced again.
void drift;
