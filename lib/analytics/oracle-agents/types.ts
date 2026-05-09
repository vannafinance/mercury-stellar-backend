export type AgentStatus = "Running" | "Warning" | "Error" | "Paused";
export type OracleStatus = "healthy" | "warning" | "stale";
export type AlertSeverity = "info" | "warning" | "critical";

export interface OracleHealth {
  asset: string;
  source: string;
  lastUpdateTimestamp: number;
  freshnessSeconds: number;
  status: OracleStatus;
}

export interface MonitoringAgent {
  id: string;
  name: string;
  description: string;
  status: AgentStatus;
  lastCheck: number;
  alertCount: number;
  interval: string;
}

export interface AlertEvent {
  id: string;
  agentId: string;
  agentName: string;
  severity: AlertSeverity;
  message: string;
  timestamp: number;
  acknowledged: boolean;
}
