/**
 * `remove_liquidity` must send arguments MCP actually accepts.
 *
 * Found live 2026-08-10: "remove half my liquidity from the XLM/USDC pool" sent
 * `fraction` / `share_fraction`, which MCP has never taken. It returned `invalid_input`
 * and the copilot showed the user MCP's own API guidance —
 * "liquidity is required for a partial remove (human string, e.g. liquidity=\"50\")…
 * Never pass raw share integers." — which is documentation, not an answer.
 */
import { describe, expect, it } from "vitest";
import { mapOpToMcpStep } from "@/lib/copilot/mcp-write";

const CTX = {
  trader: "G".padEnd(56, "A"),
  smartAccount: "C".padEnd(56, "B"),
} as never;

const remove = (params: Record<string, unknown>) =>
  mapOpToMcpStep("remove_liquidity", params as never, CTX);

describe("remove_liquidity — arguments MCP accepts, never a fraction", () => {
  it("a full exit becomes remove_all", () => {
    const r = remove({ fraction: 1, token_b: "AQUSDC" });
    expect(r.blocker).toBeUndefined();
    expect(r.step?.args.remove_all).toBe(true);
    expect(r.step?.args.fraction).toBeUndefined();
    expect(r.step?.args.share_fraction).toBeUndefined();
    expect(r.step?.label).toMatch(/Remove all/i);
  });

  it("an explicit LP amount is sent as liquidity, not a fraction", () => {
    const r = remove({ amount: 10, token_b: "AQUSDC" });
    expect(r.blocker).toBeUndefined();
    expect(r.step?.args.liquidity).toBe("10");
    expect(r.step?.args.fraction).toBeUndefined();
    expect(r.step?.args.remove_all).toBeUndefined();
  });

  /** The key fix: ask in the user's terms rather than send an argument that will 400. */
  it("a partial share asks for a figure instead of sending an unsupported arg", () => {
    const r = remove({ fraction: 0.5, token_b: "AQUSDC" });
    expect(r.step).toBeUndefined();
    expect(r.blocker).toMatch(/50%/);
    expect(r.blocker).toMatch(/remove all/i);
    // Never leak MCP's developer guidance.
    expect(r.blocker).not.toMatch(/raw share integers|human string/i);
  });

  it("still refuses BLUSDC, which is not an Aquarius LP token", () => {
    const r = remove({ fraction: 1, token_b: "BLUSDC" });
    expect(r.step).toBeUndefined();
    expect(r.blocker).toMatch(/BLUSDC/);
  });

  it("SOUSDC selects the Soroswap venue", () => {
    const r = remove({ fraction: 1, token_b: "SOUSDC" });
    expect(r.step?.args.venue).toBe("soroswap");
    expect(r.step?.args.token_b).toBe("SOUSDC");
  });
});
