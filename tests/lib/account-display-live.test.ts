import { expect, it } from "vitest";
import { loadEnvFile } from "node:process";

// Opt-in public reads and prose generation only. No signing or submission.
it.skipIf(process.env.VANNA_ACCOUNT_DISPLAY_LIVE !== "1")("compares live MCP storage with the Margin snapshot and composes the display", async () => {
  loadEnvFile(".env.local");
  const [{ computeAccountPosition }, { getMcpClient }, { accountDisplayObservations }, { normalizeResearchFacts }, { composeReply }] = await Promise.all([
    import("@/lib/copilot/investigation/capacity"), import("@/lib/copilot/mcp-client"),
    import("@/lib/copilot/investigation/account-display"), import("@/lib/copilot/investigation/normalize"),
    import("@/lib/copilot/investigation/compose"),
  ]);
  const account = process.env.VANNA_HEALTH_READ_ACCOUNT!;
  const wallet = process.env.VANNA_HEALTH_READ_WALLET!;
  expect(account).toBeTruthy();
  const started = Date.now();
  const [position, collateral, debt] = await Promise.all([
    computeAccountPosition(account),
    getMcpClient().call("vanna_get_collateral", { smart_account: account }),
    getMcpClient().call("vanna_get_debt", { smart_account: account }),
  ]);
  expect(position?.snapshot.debtDataIncomplete).toBe(false);
  expect(collateral.error).toBeUndefined();
  expect(debt.error).toBeUndefined();
  const observations = [
    { id: "e0", capability: "account_collateral", args: {}, observedAt: Date.now(), status: "ok" as const, data: collateral },
    { id: "e1", capability: "account_debt", args: {}, observedAt: Date.now(), status: "ok" as const, data: debt },
  ];
  const { facts, warnings } = normalizeResearchFacts(accountDisplayObservations(observations, position!.snapshot, 0));
  const { factualAnswer } = await import("@/lib/copilot/investigation/answer");
  const out = await composeReply({
    status: "researched", originalRequest: "Show my collateral and debt, clearly explaining the difference.", refinements: [],
    understanding: { intent: "answer", objective: "account position breakdown", constraints: [], borrowing: "unspecified" },
    message: factualAnswer(facts)!, facts, warnings, checks: [], question: null,
    scope: { wallet, smartAccount: account, network: "testnet" }, continuation: "read-only", executionAllowed: false,
  }, new AbortController().signal);
  expect(out.replyBlocks?.some((block) => block.type === "bullets" || block.type === "table")).toBe(true);
  expect(out.executionAllowed).toBe(false);
  process.stdout.write(JSON.stringify({ ms: Date.now() - started, blocks: out.replyBlocks?.map((block) => block.type), reply: out.message }) + "\n");
}, 75_000);
