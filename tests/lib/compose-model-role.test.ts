import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 24 Oct: the reply the user reads is written by the model from facts the code already verified - it phrases, it decides
 * nothing - so it does not need the research model, and sharing it meant a slow gemini-3.8-flash (18-104 s that day)
 * stalled the writing step as well as the planning. The writing role has its own model, gemini-3.5-flash (1.6-5 s on the
 * identical request); planning stays on 3.8.
 */
const sent = vi.hoisted(() => ({ models: [] as string[] }));
vi.mock("@/lib/copilot/vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/vertex")>();
  return {
    ...actual,
    generateInvestigationJson: vi.fn(async (model: string) => {
      sent.models.push(model);
      return { blocks: [{ type: "paragraph", text: "Your health factor is {{e0:health_factor}}." }] };
    }),
  };
});

afterEach(() => { vi.unstubAllEnvs(); sent.models.length = 0; vi.resetModules(); });

describe("the writing role has its own model", () => {
  it("defaults to gemini-3.5-flash while the research model stays gemini-3.8-flash", async () => {
    const { copilotConfig } = await import("@/lib/copilot/config");
    expect(copilotConfig.vertexComposeModel).toBe("gemini-3.5-flash");
    expect(copilotConfig.vertexModel).toBe("gemini-3.8-flash");
  });

  it("is a config change to move it, like every other role", async () => {
    vi.stubEnv("VERTEX_COMPOSE_MODEL", "gemini-3.8-flash");
    const { copilotConfig } = await import("@/lib/copilot/config");
    expect(copilotConfig.vertexComposeModel).toBe("gemini-3.8-flash");
  });

  it("writes the reply with that model, and plans with the research model", async () => {
    const { composeReply } = await import("@/lib/copilot/investigation/compose");
    const { healthObservations } = await import("@/lib/copilot/investigation/fast-path");
    const { normalizeResearchFacts } = await import("@/lib/copilot/investigation/normalize");
    const facts = normalizeResearchFacts(healthObservations({ grossCollateralUsd: "1916.27", debtUsd: "23.31", healthFactor: "82.2086" })
      .map((observation) => ({ ...observation, id: "e0" }))).facts;
    const view = {
      status: "researched", message: "Your health factor is 82.21.", originalRequest: "what is my health factor", refinements: [],
      understanding: { intent: "answer", objective: "health", constraints: [], borrowing: "unspecified" }, question: null, facts,
      checks: [], warnings: [], scope: { wallet: "G", smartAccount: "C", network: "testnet" }, continuation: "c", executionAllowed: false,
    } as never;
    await composeReply(view, new AbortController().signal);
    expect(sent.models).toEqual(["gemini-3.5-flash"]);
  });
});
