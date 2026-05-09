function calcHF(collateralUsd: number, debtUsd: number): number {
  if (debtUsd <= 0) return Number.POSITIVE_INFINITY;
  return collateralUsd / debtUsd;
}

function calcLTV(collateralUsd: number, debtUsd: number): number {
  if (collateralUsd <= 0) return 0;
  return debtUsd / collateralUsd;
}

function getHFStatus(hf: number): "safe" | "warning" | "danger" {
  if (!Number.isFinite(hf)) return "safe";
  if (hf < 1) return "danger";
  if (hf < 1.3) return "warning";
  return "safe";
}

export default { calcHF, calcLTV, getHFStatus };
