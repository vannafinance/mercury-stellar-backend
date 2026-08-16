"use client";

import { useTheme } from "@/contexts/theme-context";
import { useTxProgressFraction } from "@/hooks/use-tx-progress-fraction";

const SIZE = 20;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Icon for the background "in progress" toast shown when
 * TransactionProgressModal is dismissed (see dismissTxProgressToBackground).
 * A real progress ring — same fraction the modal's bar renders — instead of
 * a generic infinite spinner, so the toast visibly fills up and finishes
 * rather than just spinning forever until it flips to a success/error toast.
 */
export function TxToastProgressIcon() {
  const { isDark } = useTheme();
  const fraction = useTxProgressFraction();
  const offset = CIRCUMFERENCE * (1 - fraction);

  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="shrink-0">
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke={isDark ? "#2A2A2A" : "#EFEAFB"}
        strokeWidth={STROKE}
      />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="#703AE6"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        style={{ transition: "stroke-dashoffset 0.3s ease-out" }}
      />
    </svg>
  );
}
