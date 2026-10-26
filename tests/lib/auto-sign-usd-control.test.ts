import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ enable: vi.fn(), call: vi.fn() }));
vi.mock("@/lib/copilot/mcp-client", () => ({ getMcpClient: () => ({ call: mocks.call }) }));
vi.mock("@/lib/copilot/mcp-write", () => ({ enableAutoSign: mocks.enable }));
vi.mock("@/lib/copilot/wallet-bind", () => ({ registerWalletBind: vi.fn(), rememberConnectOrigin: vi.fn(), resolveConnectOrigin: vi.fn(), resolvePrivySignerId: vi.fn() }));
import { forgetAutoSignStatus, handleAutoSignAction } from "@/lib/copilot/handle-autosign";
const policy = { cap_unit: "testnet_usd", network: "testnet", usd_caps_enforced: true, default_per_tx_usd: "1000", default_per_day_usd: "5000", maximum_per_day_usd: "5000" };
beforeEach(() => { vi.clearAllMocks(); forgetAutoSignStatus(); });

describe("explicit dollar approval control", () => {
  it("requires a new approval choice when legacy defaults encounter dollar policy", async () => {
    mocks.enable.mockResolvedValue({ ...policy, status: "needs_confirmation", summary: "Approve dollar limits." });
    const result = await handleAutoSignAction({ user_id: "did:privy:owner", message: "use defaults", auto_sign: { action: "use_defaults" } }, "request", "GWALLET", "did:privy:owner");
    expect(result.kind).toBe("needs_auto_sign");
    expect(mocks.enable.mock.calls[0][1]).toMatchObject({ useDefaultCaps: true, usdBudgetApproved: false });
    expect(result.auto_sign?.raw).toMatchObject(policy);
  });
  it("transports dollar custom limits without token fields after explicit owner approval", async () => {
    mocks.enable.mockResolvedValue({ ...policy, enabled: true, status: "enabled", max_per_tx_usd: "3000", max_per_day_usd: "5000" });
    const result = await handleAutoSignAction({ user_id: "did:privy:owner", message: "approve custom limits", auto_sign: { action: "custom", cap_unit: "testnet_usd", max_per_tx_usd: "3000", max_per_day_usd: "5000", usd_budget_approved: true } }, "request", "GWALLET", "did:privy:owner");
    expect(result.kind).toBe("answer");
    expect(mocks.enable.mock.calls[0][1]).toMatchObject({ maxPerTxUsd: "3000", maxPerDayUsd: "5000", usdBudgetApproved: true });
    expect(mocks.enable.mock.calls[0][1]).not.toHaveProperty("maxPerTxTokens");
    expect(result.data).toMatchObject({ cap_unit: "testnet_usd", max_per_tx_usd: "3000", usd_caps_enforced: true });
  });
  it("keeps status units and enforcement from the signer rather than reply phrasing", async () => {
    mocks.call.mockResolvedValue({ ...policy, status: "enabled", enabled: true, max_per_tx_usd: "1000", max_per_day_usd: "2000", summary: "Settings saved." });
    const result = await handleAutoSignAction({ user_id: "did:privy:owner", message: "status", auto_sign: { action: "status" } }, "request", "GWALLET", "did:privy:owner");
    expect(result.data).toMatchObject({ enabled: true, cap_unit: "testnet_usd", max_per_day_usd: "2000" });
    expect(mocks.enable).not.toHaveBeenCalled();
  });
});

describe("the auto-sign status poll", () => {
  const poll = () => handleAutoSignAction({ user_id: "did:privy:owner", message: "status", auto_sign: { action: "status" } }, "request", "GWALLET", "did:privy:owner");
  // 26 Oct, live: one two-step run read the same, unchanged setting 7 times.
  it("reads the setting once for the polls that follow within a few seconds", async () => {
    mocks.call.mockResolvedValue({ ...policy, status: "enabled", enabled: true, max_per_tx_usd: "1000", max_per_day_usd: "2000" });
    for (let i = 0; i < 5; i++) await poll();
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it("shares one read between polls that arrive together", async () => {
    mocks.call.mockResolvedValue({ ...policy, status: "enabled", enabled: true, max_per_tx_usd: "1000", max_per_day_usd: "2000" });
    await Promise.all([poll(), poll(), poll()]);
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it("never serves a state from before the user changed the setting", async () => {
    mocks.call.mockResolvedValueOnce({ ...policy, status: "enabled", enabled: true, max_per_tx_usd: "1000", max_per_day_usd: "2000" });
    await poll();
    mocks.call.mockResolvedValue({ ...policy, status: "disabled", enabled: false });
    mocks.call.mockResolvedValueOnce({ status: "disabled", enabled: false }); // vanna_disable_auto_sign
    await handleAutoSignAction({ user_id: "did:privy:owner", message: "off", auto_sign: { action: "disable" } }, "request", "GWALLET", "did:privy:owner");
    const after = await poll();
    expect(after.data).toMatchObject({ enabled: false });
  });
  it("does not hold an error", async () => {
    mocks.call.mockResolvedValueOnce({ error: "signer_unreachable" }).mockResolvedValue({ ...policy, status: "enabled", enabled: true, max_per_tx_usd: "1000", max_per_day_usd: "2000" });
    const first = await poll();
    expect(first.kind).toBe("error");
    const second = await poll();
    expect(second.kind).toBe("answer");
  });
});
