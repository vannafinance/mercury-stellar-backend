import { floorAmountToInput } from "./sanitize-amount";

/** UI estimate only; the contract checks live debt and collateral at execution. */
export function maxMarginWithdrawal(balance: number, debtUsd: number, healthFactor: number, price: number): number {
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  // Contract-held XLM has no classic-account base reserve.
  if (debtUsd === 0) return balance;
  if (!Number.isFinite(debtUsd) || debtUsd < 0 || !Number.isFinite(healthFactor) || price <= 0 || !Number.isFinite(price)) return 0;
  // RiskEngine requires HF strictly greater than 1.1. Never round a risk cap up.
  return Math.max(0, Math.min(balance, (healthFactor - 1.1) * debtUsd / price) - 1e-7);
}

/** Preserve all seven token decimals on Max; integer math floors partial presets. */
export function marginWithdrawalPreset(balance: string, maximum: number, percent = 100): string {
  if (maximum <= 0 || !Number.isFinite(maximum)) return "";
  if (!Number.isInteger(percent) || percent <= 0 || percent > 100) return "";
  const limit = maximum >= Number(balance) ? balance : floorAmountToInput(maximum);
  if (!/^\d+(\.\d+)?$/.test(limit)) return "";
  const [whole, fraction = ""] = limit.split(".");
  const units = (BigInt(whole) * BigInt(10000000) + BigInt(fraction.padEnd(7, "0").slice(0, 7))) * BigInt(percent) / BigInt(100);
  if (units === BigInt(0)) return "";
  return `${units / BigInt(10000000)}.${(units % BigInt(10000000)).toString().padStart(7, "0")}`.replace(/\.?0+$/, "");
}
