import { describe, expect, it, vi } from "vitest";
import { researchTurn } from "@/lib/copilot/investigation/service";
import { mapOpToMcpStep } from "@/lib/copilot/mcp-write";

const TRADER_WALLET = "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5";
const TRADER_WALLET_NO_ACCOUNT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const EXISTING_SMART_ACCOUNT = "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C";

describe("Existing margin account detection and enforcement", () => {
  it("informs the user and suppresses duplicate writes when the wallet already has an active margin account (even if model omits write)", async () => {
    const mcp = {
      call: vi.fn(async (tool: string) => {
        if (tool === "vanna_resolve_account") {
          return { status: "found_on_chain", smart_account: EXISTING_SMART_ACCOUNT };
        }
        if (tool === "vanna_list_my_wallet_bindings") {
          return {
            has_assertion: true,
            sub: `stellar:${TRADER_WALLET}`,
            bindings: [{ wallet_address: TRADER_WALLET, active: true }],
          };
        }
        return {};
      }),
    };

    // Notice: model does NOT emit goal.write or capitalises it differently
    const result = await researchTurn(
      {
        message: "open a margin account",
        wallet: TRADER_WALLET,
        continuation: null,
      },
      {
        subject: `stellar:${TRADER_WALLET}`,
        server: "mcp-test",
        network: "testnet",
        secret: "b".repeat(32),
        mcp,
        signal: new AbortController().signal,
        model: async () => ({
          kind: "research_complete",
          goal: {
            intent: "strategy",
            // Model omitted goal.write (or re-capitalised it): Bug B reproduction!
            objective: "Open a margin account.",
            constraints: [],
            borrowing: "unspecified",
          },
          findings: [{ summary: "User requested to open a margin account.", evidenceIds: [] }],
          openQuestions: [],
        }),
      },
    );

    expect(result.status).toBe("researched");
    expect(result.message).toBe(
      `You already have an active margin account (${EXISTING_SMART_ACCOUNT}). You can deposit collateral, borrow, or manage positions directly.`,
    );
    expect(result.pendingWrite).toBeNull();
    expect(result.understanding).toBeNull();
    expect(result.proposalCandidateId).toBeNull();
    expect(result.candidates).toBeNull();
    expect(result.checks.some((c) => c.label === "margin account lookup" && c.status === "ok")).toBe(true);
    expect(result.facts.some((f) => f.label === "smart account" && f.value === EXISTING_SMART_ACCOUNT)).toBe(true);
  });

  it("prompts the user to approve deploying a smart account when no active account exists (even if model re-capitalised quote)", async () => {
    const mcp = {
      call: vi.fn(async (tool: string) => {
        if (tool === "vanna_resolve_account") {
          return { status: "required", smart_account: null };
        }
        if (tool === "vanna_list_my_wallet_bindings") {
          return {
            has_assertion: true,
            sub: `stellar:${TRADER_WALLET_NO_ACCOUNT}`,
            bindings: [{ wallet_address: TRADER_WALLET_NO_ACCOUNT, active: true }],
          };
        }
        return {};
      }),
    };

    const result = await researchTurn(
      {
        message: "open a margin account",
        wallet: TRADER_WALLET_NO_ACCOUNT,
        continuation: null,
      },
      {
        subject: `stellar:${TRADER_WALLET_NO_ACCOUNT}`,
        server: "mcp-test",
        network: "testnet",
        secret: "b".repeat(32),
        mcp,
        signal: new AbortController().signal,
        model: async () => ({
          kind: "research_complete",
          goal: {
            intent: "strategy",
            // Model re-capitalised sourceQuote:
            write: { op: "create_account", sourceQuote: "Open a margin account." },
            objective: "Open a margin account.",
            constraints: [],
            borrowing: "unspecified",
          },
          findings: [{ summary: "User requested to open a margin account.", evidenceIds: [] }],
          openQuestions: [],
        }),
      },
    );

    expect(result.status).toBe("researched");
    expect(result.message).toBe(
      "No active margin account was found for your wallet. Approve below to deploy and initialize your margin smart account.",
    );
    expect(result.pendingWrite).toEqual({ op: "create_account" });
    expect(result.understanding?.objective).toBe("Open a margin account.");
  });

  it("blocks duplicate account creation in mapOpToMcpStep when an account is already present", () => {
    const blocked = mapOpToMcpStep(
      "create_account",
      {},
      { trader: TRADER_WALLET, smartAccount: EXISTING_SMART_ACCOUNT },
    );
    expect(blocked.blocker).toBe(
      `You already have an active margin account (${EXISTING_SMART_ACCOUNT}). You can deposit collateral, borrow, or manage positions directly.`,
    );

    const allowed = mapOpToMcpStep(
      "create_account",
      {},
      { trader: TRADER_WALLET, smartAccount: null },
    );
    expect(allowed.step).toEqual({
      tool: "vanna_open_account",
      args: { trader: TRADER_WALLET },
      label: "Create smart account",
    });
  });
});
