import { expect, it, vi } from "vitest";
import { loadEnvFile } from "node:process";

// Explicit opt-in: public account reads only. Never signs or submits transactions.
it.skipIf(process.env.VANNA_HEALTH_READ_LIVE !== "1")("reads complete live health through the Copilot read pipeline", async () => {
  loadEnvFile(".env.local");
  if (process.env.VANNA_HEALTH_READ_PROFILE === "1") {
    const SDK = await import("@stellar/stellar-sdk");
    const simulate = SDK.rpc.Server.prototype.simulateTransaction;
    vi.spyOn(SDK.rpc.Server.prototype, "simulateTransaction").mockImplementation(async function (this: InstanceType<typeof SDK.rpc.Server>, ...args: Parameters<typeof simulate>) {
      const op = args[0].operations[0];
      const name = op.type === "invokeHostFunction" ? op.func.invokeContract().functionName().toString() : op.type;
      const started = Date.now();
      try { return await simulate.apply(this, args); }
      finally { process.stdout.write(`RPC ${name}: ${Date.now() - started}ms\n`); }
    });
    const fetchOriginal = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const started = Date.now();
      const host = new URL(String(args[0])).hostname;
      try { return await fetchOriginal(...args); }
      finally { process.stdout.write(`HTTP ${host}: ${Date.now() - started}ms\n`); }
    });
  }
  const [{ getMcpClient }, { computeAccountPosition }, { readHealthFastPath, fastPathView }, { computeMarginSnapshot }] = await Promise.all([
    import("@/lib/copilot/mcp-client"), import("@/lib/copilot/investigation/capacity"),
    import("@/lib/copilot/investigation/fast-path"), import("@/lib/account-snapshot"),
  ]);
  const { ACCOUNT_READ_BUDGET_MS } = await import("@/lib/copilot/investigation/service");
  const scope = { subject: "read_only_diagnostic", trader: process.env.VANNA_HEALTH_READ_WALLET!, smartAccount: process.env.VANNA_HEALTH_READ_ACCOUNT!, network: "testnet" };
  expect(scope.trader).toBeTruthy();
  expect(scope.smartAccount).toBeTruthy();
  // Default to a cold prompt. Opt in separately to the sidebar-then-question
  // case; prewarming must never hide a failing cold read.
  let coldSnapshotMs: number | null = null;
  if (process.env.VANNA_HEALTH_READ_PREWARM === "1") {
    const snapshotStarted = Date.now();
    await computeMarginSnapshot(scope.smartAccount);
    coldSnapshotMs = Date.now() - snapshotStarted;
  }
  const questionStarted = Date.now();
  const observations = await readHealthFastPath({ scope, mcp: getMcpClient(), signal: new AbortController().signal, budgetMs: ACCOUNT_READ_BUDGET_MS, snapshotFallback: () => computeAccountPosition(scope.smartAccount) });
  const view = fastPathView({ message: "What's my health factor?", scope, observations, secret: "diagnostic-secret-".repeat(4), server: "live-read-diagnostic" });
  expect(view.facts).toContainEqual(expect.objectContaining({ sourcePath: "health_factor", unit: "HF" }));
  expect(view.status).toBe("researched");
  expect(view.executionAllowed).toBe(false);
  expect(view.warnings).toEqual([]);
  process.stdout.write(`${JSON.stringify({ status: view.status, reply: view.message, warnings: view.warnings.length, coldSnapshotMs, questionMs: Date.now() - questionStarted })}\n`);
}, 75_000);
