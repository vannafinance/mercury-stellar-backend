import { describe, expect, it } from "vitest";
import { acceptedTestnetBudget, defaultTestnetBudget, storedTestnetBudget, readStoredTestnetBudget, testnetBudgetLabel, testnetBudgetDraft } from "@/lib/copilot/auto-approve-budget";
import { preserveLastConclusiveSignState, signServiceFromSessionRead } from "@/components/copilot/session-auto-sign";

describe("Testnet budget authority", () => {
  it("keeps edited dollar limits separate from the accepted policy", () => {
    const active = { tx: 1000, day: 5000, unit: "testnet_usd" as const };
    const draft = testnetBudgetDraft({ tx: "3000", day: "5000", dollar: true, maximumDay: 5000, active });
    expect(draft).toEqual({ value: { tx: 3000, day: 5000, unit: "testnet_usd" }, error: null, changed: true });
    expect(active.tx).toBe(1000);
    expect(testnetBudgetDraft({ tx: "1000.00", day: "5000", dollar: true, maximumDay: 5000, active }).changed).toBe(false);
  });
  it("rejects excessive daily limits and invalid precision without imposing a separate default transaction ceiling", () => {
    for (const [tx, day] of [["1000", "5000.000001"], ["0", "5000"], ["2", "1"], ["1.0000001", "5000"], ["1e3", "5000"]]) {
      expect(testnetBudgetDraft({ tx, day, dollar: true, maximumDay: 5000, active: null }).value).toBeNull();
    }
    expect(testnetBudgetDraft({ tx: "0.10", day: "5000", dollar: true, maximumDay: 5000, active: null }).value?.tx).toBe(0.1);
    expect(testnetBudgetDraft({ tx: "5000", day: "5000", dollar: true, maximumDay: 5000, active: null }).error).toBeNull();
  });
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
  it("requires complete verified dollar limits without interpreting legacy quantities", () => {
    const data = { cap_unit: "testnet_usd", network: "testnet", usd_caps_enforced: true, max_per_tx_usd: "3000", max_per_day_usd: "5000" };
    expect(acceptedTestnetBudget(data)).toEqual({ tx: 3000, day: 5000, unit: "testnet_usd" });
    for (const invalid of [{ ...data, usd_caps_enforced: false }, { ...data, network: "mainnet" }, { ...data, max_per_tx_usd: "1.0000001" },
      { ...data, max_per_day_usd: "2000" }, { ...data, max_per_tx_usd: null, max_per_tx_tokens: "3000" }]) expect(acceptedTestnetBudget(invalid)).toBeNull();
  });
  it("reads daily maximum from signer policy and preserves display units through reload", () => {
    const value = defaultTestnetBudget({ cap_unit: "testnet_usd", network: "testnet", usd_caps_enforced: true,
      default_per_tx_usd: "1000", default_per_day_usd: "5000", maximum_per_day_usd: "5000" });
    expect(value).toEqual({ tx: 1000, day: 5000, unit: "testnet_usd", maximumDay: 5000 });
    expect(testnetBudgetLabel(value!)).toBe("$1000 per transaction · $5000 per day");
    expect(readStoredTestnetBudget(storedTestnetBudget(value!))).toEqual({ tx: 1000, day: 5000, unit: "testnet_usd" });
    expect(readStoredTestnetBudget({ max_per_tx_tokens: 1000, max_per_day_tokens: 2000 })).toEqual({ tx: 1000, day: 2000 });
  });
  it("clears stale active authority when dollar enforcement or the session is disabled", () => {
    for (const status of ["disabled", "policy_unavailable"]) {
      const next = signServiceFromSessionRead({ data: { enabled: false, status, cap_unit: "testnet_usd", usd_caps_enforced: false } });
      expect(next.status).toBe(status === "disabled" ? "unknown" : "unavailable");
      if (status === "policy_unavailable") expect(next.authoritative).toBe(true);
      expect(preserveLastConclusiveSignState({ status: "ok", reason: null }, next)).toEqual(next);
    }
  });
});
