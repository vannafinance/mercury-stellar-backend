import { expect, it } from "vitest";
import { loadEnvFile } from "node:process";

// Synthetic values only: exercises the configured provider without account data.
it.skipIf(process.env.VANNA_PROSE_LIVE !== "1")("composes a structured fictional account overview through the configured provider", async () => {
  loadEnvFile(".env.local");
  const { composeReply } = await import("@/lib/copilot/investigation/compose");
  const out = await composeReply({
    status: "researched", originalRequest: "Explain this fictional example account, then list collateral and debt in separate bullet groups.", refinements: [],
    understanding: { intent: "answer", objective: "fictional account overview", constraints: [], borrowing: "unspecified" },
    facts: [
      { id: "example:collateral", label: "ExampleAsset gross balance before debt", value: "70.1234567", unit: "ExampleAsset", quantity: true, venue: "margin", evidenceId: "synthetic", sourcePath: "balances_before_debt[0].balance", readAt: 0 },
      { id: "example:debt", label: "ExampleAsset outstanding debt", value: "30.1234567", unit: "ExampleAsset", quantity: true, venue: "margin", evidenceId: "synthetic", sourcePath: "debt[0].balance", readAt: 0 },
    ], message: "Synthetic account overview", warnings: [], checks: [], question: null,
    scope: { wallet: null, smartAccount: null, network: "testnet" }, continuation: "synthetic", executionAllowed: false,
  }, new AbortController().signal);
  expect(out.replyBlocks?.some((block) => block.type === "bullets")).toBe(true);
  process.stdout.write(JSON.stringify({ reply: out.message, blocks: out.replyBlocks?.map((block) => block.type) }) + "\n");
}, 30_000);
