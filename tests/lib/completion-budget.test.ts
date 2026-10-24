import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 24 Oct, live: "Deposit 12 XLM ... then tell me my account leverage and my XLM liquidation price" settled and the chat
 * said only "Done. Deposited 12 XLM as collateral." - the receipt-only fallback, shown when the model-written summary does
 * not arrive. With Gemini 3.8 degraded, the summary's 15 s writing budget ended before a slow primary call could fail
 * over to the fallback model (15 s threshold), so the user's trailing ask was never answered.
 *
 * The invariant: the summary may wait long enough for a failover and a fallback answer, and the browser waits longer than the
 * server does. Asserted against the source so no one retunes one number alone.
 */
const read = (path: string) => readFileSync(path, "utf8");
const num = (source: string, pattern: RegExp, label: string) => {
  const match = source.match(pattern);
  if (!match) throw new Error(`could not find ${label}`);
  return Number(match[1].replace(/_/g, ""));
};

describe("the completion summary's time budget", () => {
  const compose = read("lib/copilot/investigation/compose.ts");
  const vertex = read("lib/copilot/vertex.ts");
  const client = read("hooks/composed-completion.ts");
  const route = read("app/api/copilot/workflow/[id]/reply/route.ts");
  const summaryMs = num(compose, /COMPLETION_COMPOSE_BUDGET_MS\s*=\s*([\d_]+)/, "completion writing budget");
  const slowMs = num(vertex, /positiveEnvMs\("COPILOT_MODEL_SLOW_MS",\s*([\d_]+)\)/, "failover threshold");
  const healthMs = num(route, /HEALTH_READ_MS\s*=\s*([\d_]+)/, "post-run health read");
  const clientMs = num(client, /AbortSignal\.timeout\(([\d_]+)\)/, "browser wait");

  it("lets the writer outlast the failover threshold with room for the fallback to answer", () => {
    expect(summaryMs).toBeGreaterThanOrEqual(slowMs + 10_000);
  });
  it("makes the browser wait for the health read, the writing step and a little more", () => {
    expect(clientMs).toBeGreaterThanOrEqual(healthMs + summaryMs + 5_000);
  });
});
