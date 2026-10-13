export interface TestnetBudget { tx: number; day: number; unit?: "testnet_usd"; maximumDay?: number }

/** Editing a draft does not change the server policy or confer signing authority. */
export function testnetBudgetDraft(input: { tx: string; day: string; dollar: boolean; maximumDay?: number; active: TestnetBudget | null }) {
  const precision = input.dollar ? /^\d+(?:\.\d{1,6})?$/ : /^\d+(?:\.\d{1,7})?$/;
  const tx = Number(input.tx), day = Number(input.day);
  let error: string | null = null;
  if (!precision.test(input.tx) || !precision.test(input.day) || !Number.isFinite(tx) || !Number.isFinite(day) || tx <= 0 || day < tx) {
    error = "Enter a positive per-transaction limit and a daily limit at least as large.";
  } else if (input.dollar && input.maximumDay != null && day > input.maximumDay) {
    error = `Daily limit cannot exceed $${input.maximumDay}.`;
  }
  const value: TestnetBudget | null = error ? null : { tx, day, ...(input.dollar ? { unit: "testnet_usd" as const } : {}) };
  const changed = !value || !input.active || value.tx !== input.active.tx || value.day !== input.active.day || value.unit !== input.active.unit;
  return { value, error, changed };
}

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
  if (data.cap_unit === "testnet_usd" && data.network === "testnet" && data.usd_caps_enforced === true) {
    const accepted = budget(data.max_per_tx_usd, data.max_per_day_usd);
    return accepted && accepted.tx > 0 && [data.max_per_tx_usd, data.max_per_day_usd].every(value => /^\d+(?:\.\d{1,6})?$/.test(String(value)))
      ? { ...accepted, unit: "testnet_usd" } : null;
  }
  return data.cap_unit === "token_units" && data.network === "testnet" && data.token_caps_enforced === true
    ? budget(data.max_per_tx_tokens, data.max_per_day_tokens) : null;
}

export function defaultTestnetBudget(data: Record<string, unknown>): TestnetBudget | null {
  if (data.cap_unit === "testnet_usd" && data.network === "testnet" && data.usd_caps_enforced === true) {
    const defaults = budget(data.default_per_tx_usd, data.default_per_day_usd);
    const maximum = Number(data.maximum_per_day_usd);
    return defaults && defaults.tx > 0 && Number.isFinite(maximum) && maximum >= defaults.day
      ? { ...defaults, unit: "testnet_usd", maximumDay: maximum } : null;
  }
  return data.cap_unit === "token_units" && data.network === "testnet" ? budget(data.default_per_tx_tokens, data.default_per_day_tokens) : null;
}

export function testnetBudgetLabel(value: TestnetBudget): string {
  return value.unit === "testnet_usd" ? `$${value.tx} per transaction · $${value.day} per day` : `${value.tx} units per transaction · ${value.day} units per day`;
}

/** Display-only storage still preserves units across reloads. */
export function storedTestnetBudget(value: TestnetBudget): Record<string, unknown> {
  return value.unit === "testnet_usd" ? { cap_unit: "testnet_usd", max_per_tx_usd: value.tx, max_per_day_usd: value.day }
    : { cap_unit: "token_units", max_per_tx_tokens: value.tx, max_per_day_tokens: value.day };
}

export function readStoredTestnetBudget(data: Record<string, unknown>): TestnetBudget | null {
  return acceptedTestnetBudget({ ...data, cap_unit: data.cap_unit ?? "token_units", network: "testnet", token_caps_enforced: true, usd_caps_enforced: true });
}
