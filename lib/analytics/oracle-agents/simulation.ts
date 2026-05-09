import type {
  AlertEvent,
  AlertSeverity,
  MonitoringAgent,
  OracleHealth,
  OracleStatus,
} from "./types";

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
    "Position health factor dropped below 1.10 — liquidation bot triggered",
    "Liquidation attempt failed — retrying with higher gas",
    "Slippage estimate 8.2% for LP collateral liquidation",
    "No liquidator response in 45s — escalating",
  ],
  "track-token-verifier": [
    "vBTC-PERP deviation spiked to 2.8% temporarily",
    "vETH-USDC-LP IL causing 3.1% value gap",
    "Cross-check passed — all track tokens within threshold",
    "vETH-PERP basis spread widened to 1.2%",
  ],
  "oracle-watcher": [
    "SOL oracle stale — freshness exceeds 60s",
    "ETH Chainlink heartbeat healthy — 12s",
    "BTC oracle deviation between Chainlink and Pyth: 0.3%",
    "New borrows paused for SOL — oracle freshness critical",
  ],
  "liquidity-stress": [
    "Stress test passed — insurance covers 1.74x worst-case shortfall",
    "Warning: 30% ETH crash scenario would exceed insurance by $70K",
    "Hourly simulation complete — 2 of 3 scenarios passing",
  ],
  "protocol-monitor": [
    "GMX TVL stable — $480M (+0.2%)",
    "dYdX maintenance window detected — monitoring",
    "Uniswap V3 ETH-USDC pool depth adequate for liquidations",
  ],
  "correlation-risk": [
    "ETH-correlated positions now 42% of pool — approaching 45% threshold",
    "Concentration alert: 3 whale accounts hold 28% of total borrows",
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

  const oracles: OracleHealth[] = [
    {
      asset: "ETH",
      source: "Chainlink",
      lastUpdateTimestamp: now - 12_000,
      freshnessSeconds: 12,
      status: "healthy",
    },
    {
      asset: "BTC",
      source: "Chainlink",
      lastUpdateTimestamp: now - 8_000,
      freshnessSeconds: 8,
      status: "healthy",
    },
    {
      asset: "SOL",
      source: "Pyth",
      lastUpdateTimestamp: now - 47_000,
      freshnessSeconds: 47,
      status: "warning",
    },
  ];

  const agents: MonitoringAgent[] = [
    {
      id: "liquidation-guard",
      name: "Liquidation Guard Agent",
      description:
        "Scans all positions every 15s. Triggers liquidation bots. Alerts if no liquidator responds in 60s.",
      status: "Running",
      lastCheck: now - 3_000,
      alertCount: 2,
      interval: "15s",
    },
    {
      id: "track-token-verifier",
      name: "Track Token Verifier",
      description:
        "Cross-checks track token value vs underlying protocol position. Flags deviation >2%.",
      status: "Running",
      lastCheck: now - 12_000,
      alertCount: 1,
      interval: "30s",
    },
    {
      id: "oracle-watcher",
      name: "Oracle Staleness Watcher",
      description:
        "Monitors all price feeds. Pauses new borrows if any critical oracle stale >60s.",
      status: "Warning",
      lastCheck: now - 5_000,
      alertCount: 3,
      interval: "10s",
    },
    {
      id: "liquidity-stress",
      name: "Liquidity Stress Agent",
      description:
        "Runs simulation: if top 10 borrowers default, does insurance cover shortfall? Hourly.",
      status: "Running",
      lastCheck: now - 1_800_000,
      alertCount: 0,
      interval: "1h",
    },
    {
      id: "protocol-monitor",
      name: "Integrated Protocol Monitor",
      description:
        "Pings GMX, dYdX, Uniswap, farm protocols every 30s. Alerts if TVL drops >15% sudden.",
      status: "Running",
      lastCheck: now - 15_000,
      alertCount: 0,
      interval: "30s",
    },
    {
      id: "correlation-risk",
      name: "Correlation Risk Agent",
      description:
        "Detects if multiple large positions hold correlated assets. Triggers concentration alert.",
      status: "Running",
      lastCheck: now - 60_000,
      alertCount: 1,
      interval: "5m",
    },
  ];

  const alerts: AlertEvent[] = [
    {
      id: "init-1",
      agentId: "oracle-watcher",
      agentName: "Oracle Staleness Watcher",
      severity: "warning",
      message: "SOL oracle freshness exceeds 30s threshold (47s)",
      timestamp: now - 20_000,
      acknowledged: false,
    },
    {
      id: "init-2",
      agentId: "track-token-verifier",
      agentName: "Track Token Verifier",
      severity: "critical",
      message: "vETH-USDC-LP deviation at 4.3% — exceeds 2% threshold",
      timestamp: now - 45_000,
      acknowledged: false,
    },
    {
      id: "init-3",
      agentId: "liquidation-guard",
      agentName: "Liquidation Guard Agent",
      severity: "warning",
      message: "Position 0x4f2...a1b health factor at 1.08 — liquidation imminent",
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
