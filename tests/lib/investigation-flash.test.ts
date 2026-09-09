import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/copilot/vertex", () => ({ generateInvestigationJson: vi.fn() }));
vi.mock("@/lib/copilot/mcp-client", () => ({ getMcpClient: vi.fn() }));

import { createFlashResearchModel, investigateWithFlash, researchThinkingLevel } from "@/lib/copilot/investigation/flash";
import { generateInvestigationJson } from "@/lib/copilot/vertex";
import { getMcpClient } from "@/lib/copilot/mcp-client";
import type { ResearchTurn } from "@/lib/copilot/investigation/types";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("Flash research adapter", () => {
  it("snapshots the configured Flash model and forwards context and cancellation", async () => {
    vi.stubEnv("VERTEX_MODEL", "gemini-3.8-flash");
    const model = createFlashResearchModel();
    vi.stubEnv("VERTEX_MODEL", "gemini-3.7-flash");
    const turn: ResearchTurn = {
      message: "Investigate my strategy", history: [], observations: [], capabilities: [],
      context: { network: "testnet", hasWallet: false, hasSmartAccount: false }, remaining: { turns: 2, toolCalls: 1 },
    };
    const signal = new AbortController().signal;
    vi.mocked(generateInvestigationJson).mockResolvedValue({ kind: "clarify", question: "Which objective?" });
    await model(turn, signal);
    expect(generateInvestigationJson).toHaveBeenCalledWith(
      "gemini-3.8-flash", expect.stringContaining("Permission to borrow is optional"), JSON.stringify(turn), signal,
      "LOW",
    );
  });

  /**
   * Reasoning effort is billed, so it is chosen per turn: picking the next read from a fixed
   * capability list is mechanical, while synthesising goal + evidence-linked findings is the
   * one hard call. Every turn at MEDIUM spent reasoning tokens on the easy ones.
   */
  it("reasons cheaply while gathering and escalates only to conclude", () => {
    const turn = (over: Partial<ResearchTurn>): ResearchTurn => ({
      message: "Investigate my strategy", history: [], observations: [], capabilities: [],
      context: { network: "testnet", hasWallet: true, hasSmartAccount: true },
      remaining: { turns: 8, toolCalls: 8 }, ...over,
    });
    const observation = (id: string) => ({
      id, capability: "wallet_balances", args: {}, observedAt: 0, status: "ok" as const,
    });

    expect(researchThinkingLevel(turn({}))).toBe("LOW");
    // Budget exhausted: this turn has to produce a conclusion, so pay for the reasoning.
    expect(researchThinkingLevel(turn({ remaining: { turns: 8, toolCalls: 0 } }))).toBe("MEDIUM");
    // Last turn available — no further read can inform it.
    expect(researchThinkingLevel(turn({ remaining: { turns: 1, toolCalls: 8 } }))).toBe("MEDIUM");
    // Enough evidence in hand that a handoff is plausible.
    expect(researchThinkingLevel(turn({
      observations: ["e1", "e2", "e3", "e4"].map(observation),
    }))).toBe("MEDIUM");
  });

  it("rejects non-Flash configuration before provider or MCP calls", () => {
    vi.stubEnv("VERTEX_MODEL", "gemini-3.8-pro");
    expect(createFlashResearchModel).toThrow("Gemini Flash");
    expect(generateInvestigationJson).not.toHaveBeenCalled();
    expect(getMcpClient).not.toHaveBeenCalled();
  });

  it("requires the authenticated subject before entering the production adapter", async () => {
    await expect(investigateWithFlash({
      message: "Check my debt", scope: { subject: "unbound", trader: null, smartAccount: null, network: "testnet" },
    })).rejects.toThrow("subject is not bound");
    expect(generateInvestigationJson).not.toHaveBeenCalled();
    expect(getMcpClient).not.toHaveBeenCalled();
  });
});
