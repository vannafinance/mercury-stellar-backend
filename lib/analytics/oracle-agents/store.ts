"use client";

import { create } from "zustand";
import { useEffect, useRef } from "react";
import type { AlertEvent, MonitoringAgent, OracleHealth } from "./types";
import {
  createOracleAgentsInitialState,
  simulateOracleAgentsTick,
} from "./simulation";

interface OracleAgentsStore {
  oracles: OracleHealth[];
  agents: MonitoringAgent[];
  alerts: AlertEvent[];
  lastUpdated: number;
  initialized: boolean;
  init: () => void;
  tick: () => void;
  acknowledgeAlert: (id: string) => void;
}

export const useOracleAgentsStore = create<OracleAgentsStore>((set, get) => ({
  ...createOracleAgentsInitialState(),
  initialized: false,

  init: () => {
    if (!get().initialized) {
      set({ ...createOracleAgentsInitialState(), initialized: true });
    }
  },

  tick: () => {
    const { oracles, agents, alerts } = get();
    const next = simulateOracleAgentsTick({ oracles, agents, alerts });
    set({ ...next });
  },

  acknowledgeAlert: (id: string) => {
    set((state) => ({
      alerts: state.alerts.map((a) =>
        a.id === id ? { ...a, acknowledged: true } : a
      ),
    }));
  },
}));

export function useOracleAgentsSimulation(intervalMs = 3000) {
  const tick = useOracleAgentsStore((s) => s.tick);
  const init = useOracleAgentsStore((s) => s.init);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    init();
    intervalRef.current = setInterval(tick, intervalMs);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [tick, init, intervalMs]);
}
