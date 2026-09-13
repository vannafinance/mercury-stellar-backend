// Margin calculation utilities — Protocol_V1_Soroban testnet RiskEngine.
// HF = collateral / debt. Liquidatable when HF <= 1.1. Max LTV = 1/1.1.

import { LIQUIDATION_THRESHOLD, MAX_LTV } from "@/lib/margin-health";

const PROTOCOL_CONSTANTS = {
  MAX_LTV,
  MIN_HEALTH_FACTOR: LIQUIDATION_THRESHOLD,
};

const calcHF = (collUsd: number, debtUsd: number): number => {
  if (debtUsd <= 0) return Infinity;
  if (collUsd <= 0) return 0;
  return collUsd / debtUsd;
};

const calcLeverage = (collUsd: number, debtUsd: number): number => {
  const equity = collUsd - debtUsd;
  if (equity <= 0) return Infinity;
  return collUsd / equity;
};

const marginCalc = {
  PROTOCOL_CONSTANTS,
  calcHF,
  calcLeverage,
};

export default marginCalc;
