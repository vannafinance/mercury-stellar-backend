import { describe, expect, it } from "vitest";
import { acceptedTestnetBudget, defaultTestnetBudget } from "@/lib/copilot/auto-approve-budget";
import { preserveLastConclusiveSignState, signServiceFromSessionRead } from "@/components/copilot/session-auto-sign";

describe("Testnet budget authority", () => {
  it("requires explicit testnet enforcement and both accepted caps", () => {
    const data = { cap_unit: "token_units", network: "testnet", token_caps_enforced: true, max_per_tx_tokens: "750.25", max_per_day_tokens: "4000" };
    expect(acceptedTestnetBudget(data)).toEqual({ tx: 750.25, day: 4000 });
    for (const invalid of [{ ...data, cap_unit: "USD" }, { ...data, token_caps_enforced: false }, { ...data, max_per_day_tokens: null }, { ...data, max_per_day_tokens: 500 }, { ...data, max_per_tx_tokens: Infinity }]) expect(acceptedTestnetBudget(invalid)).toBeNull();
  });
  it("preserves independent signer defaults without inventing a dollar value", () => {
    expect(defaultTestnetBudget({ cap_unit: "token_units", network: "testnet", default_per_tx_tokens: 1000, default_per_day_tokens: 5000 })).toEqual({ tx: 1000, day: 5000 });
    expect(defaultTestnetBudget({ default_cap_usd: 1000 })).toBeNull();
  });
  it("does not retain a cached active state after the server denies token enforcement", () => {
    const next = signServiceFromSessionRead({ data: { enabled: true, cap_unit: "token_units", network: "testnet", max_per_tx_tokens: 1000, max_per_day_tokens: 5000 } });
    expect(next.status).toBe("unavailable");
    expect(preserveLastConclusiveSignState({ status: "ok", reason: null }, next)).toEqual(next);
  });
});
