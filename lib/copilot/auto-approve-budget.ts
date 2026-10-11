export interface TestnetBudget { tx: number; day: number }

function budget(tx: unknown, day: unknown): TestnetBudget | null {
  const valid = (value: unknown) => typeof value === "number" ||
    (typeof value === "string" && /^\d+(?:\.\d{1,7})?$/.test(value));
  if (!valid(tx) || !valid(day)) return null;
  const perTx = Number(tx);
  const perDay = Number(day);
  return Number.isFinite(perTx) && Number.isFinite(perDay) && perTx >= 0 && perDay >= perTx
    ? { tx: perTx, day: perDay } : null;
}

export function acceptedTestnetBudget(data: Record<string, unknown>): TestnetBudget | null {
  return data.cap_unit === "token_units" && data.network === "testnet" && data.token_caps_enforced === true
    ? budget(data.max_per_tx_tokens, data.max_per_day_tokens) : null;
}

export function defaultTestnetBudget(data: Record<string, unknown>): TestnetBudget | null {
  return data.cap_unit === "token_units" && data.network === "testnet" ? budget(data.default_per_tx_tokens, data.default_per_day_tokens) : null;
}
