// Margin calculation utilities — aligned with Vanna Risk Explorer simulation

const PROTOCOL_CONSTANTS = {
  COLLATERAL_FACTOR: 0.9,
  MAX_LTV: 0.9,
  MIN_HEALTH_FACTOR: 1.0,
};

const calcHF = (collUsd: number, debtUsd: number): number => {
  if (debtUsd <= 0) return Infinity;
  if (collUsd <= 0) return 0;
  return (collUsd * PROTOCOL_CONSTANTS.COLLATERAL_FACTOR) / debtUsd;
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
