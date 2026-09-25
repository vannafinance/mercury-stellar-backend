import { describe, expect, it } from "vitest";
import { resolvePlans } from "@/lib/copilot/investigation/plan";
import { fastPathView } from "@/lib/copilot/investigation/fast-path";
import { buildQuestionnaireSet } from "@/lib/copilot/investigation/questionnaire";
import { researchTurn } from "@/lib/copilot/investigation/service";
import { touchesMarginAccount, OP_FLOW, WORKFLOW_OPS } from "@/lib/copilot/workflow/types";
import type { Observation } from "@/lib/copilot/investigation/types";

const NOW = 1_700_000_000_000;
const TRADER = "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA";

const obs = (id: string, capability: string, data: Record<string, unknown>, args: Record<string, unknown> = {}): Observation =>
  ({ id, capability, args, observedAt: NOW, status: "ok", data });
const wallet = (rows: Array<{ symbol: string; balance: string }>) =>
  obs("w", "wallet_balances", { assets: rows.map((row) => ({ ...row, decimals: 7, status: "ok" })), fee_reserve_xlm: "0" });
const prices = ["XLM", "BLUSDC"].map((asset) =>
  obs(`p-${asset}`, "asset_price", { price_usd: asset === "XLM" ? "0.2" : "1" }, { asset }));
const blend = obs("b", "blend_markets", { reserves: [{ symbol: "XLM", supply_apr_pct: "12" }, { symbol: "USDC", supply_apr_pct: "8" }] });
const earn = obs("e", "earn_market", { supply_apr_pct: "5" }, { asset: "BLUSDC" });

const observations = [
  wallet([{ symbol: "XLM", balance: "1000" }, { symbol: "BLUSDC", balance: "400" }]),
  ...prices, blend, earn,
];

describe("no-margin-account gate", () => {
  it("derives touchesMarginAccount from OP_FLOW for all workflow ops", () => {
    for (const op of WORKFLOW_OPS) {
      const flow = OP_FLOW[op];
      const touches = flow.from === "account" || flow.to === "account";
      expect(touchesMarginAccount(op)).toBe(touches);
    }
    expect(touchesMarginAccount("deposit_collateral")).toBe(true);
    expect(touchesMarginAccount("supply_blend")).toBe(true);
    expect(touchesMarginAccount("borrow")).toBe(true);
    expect(touchesMarginAccount("repay")).toBe(true);
    expect(touchesMarginAccount("withdraw_collateral")).toBe(true);
    expect(touchesMarginAccount("swap")).toBe(true);
    expect(touchesMarginAccount("lend")).toBe(false);
  });

  it("Prompt 1: deposit 100 xlm with no margin account rejects with accountRequired", () => {
    const ctx = {
      scope: { subject: "user", network: "testnet", trader: TRADER, smartAccount: null },
      observations, now: NOW, messages: ["deposit 100 xlm"],
      capacity: null, borrowing: "unspecified" as const, comparisons: [],
    };
    const plan = {
      title: "deposit 100 xlm", rationale: "r", evidenceIds: [],
      legs: [{ op: "deposit_collateral" as const, asset: "XLM", sizing: { kind: "literal" as const, amount: "100", sourceQuote: "100" } }],
    };
    const res = resolvePlans([plan], ctx);
    expect(res.candidates).toHaveLength(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].accountRequired).toEqual({
      code: "accountRequired",
      actions: ["Deposit XLM"],
    });
  });

  it("Prompt 2: what is my health factor with no margin account returns fast-path notice and create_account choice", () => {
    const scope = { subject: "user" as const, network: "testnet" as const, trader: TRADER, smartAccount: null };
    const healthObs = obs("h", "liquidation_snapshot", {}, { error: "no_account" });
    healthObs.status = "error";
    healthObs.error = "no_account";
    const res = fastPathView({
      message: "what is my health factor",
      scope,
      observations: [healthObs],
      secret: "0".repeat(64),
      server: "test",
    });
    expect(res.message).toBe("A margin account is needed to check your health factor and none is connected.");
    expect(res.choices).toEqual([
      { id: "create_account", label: "Open a margin account", write: "create_account" },
    ]);
  });

  it("Prompt 3: supply xlm to blend with no margin account rejects with accountRequired", () => {
    const ctx = {
      scope: { subject: "user", network: "testnet", trader: TRADER, smartAccount: null },
      observations, now: NOW, messages: ["supply xlm to blend"],
      capacity: null, borrowing: "unspecified" as const, comparisons: [],
    };
    const plan = {
      title: "supply xlm to blend", rationale: "r", evidenceIds: [],
      legs: [{ op: "supply_blend" as const, asset: "XLM", sizing: { kind: "literal" as const, amount: "100", sourceQuote: "100" } }],
    };
    const res = resolvePlans([plan], ctx);
    expect(res.candidates).toHaveLength(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].accountRequired).toEqual({
      code: "accountRequired",
      actions: ["Supply XLM"],
    });
  });

  it("mixed request without margin account runs Earn and isolates account-needing legs", () => {
    const ctx = {
      scope: { subject: "user", network: "testnet", trader: TRADER, smartAccount: null },
      observations, now: NOW, messages: ["lend 20 blusdc and deposit 100 xlm"],
      capacity: null, borrowing: "unspecified" as const, comparisons: [],
    };
    const mixedPlan = {
      title: "lend 20 blusdc and deposit 100 xlm", rationale: "r", evidenceIds: [],
      legs: [
        { op: "lend" as const, asset: "BLUSDC", sizing: { kind: "literal" as const, amount: "20", sourceQuote: "20" } },
        { op: "deposit_collateral" as const, asset: "XLM", sizing: { kind: "literal" as const, amount: "100", sourceQuote: "100" } },
      ],
    };
    const res = resolvePlans([mixedPlan], ctx);
    // The Earn part still runs as a candidate
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]!.steps).toHaveLength(1);
    expect(res.candidates[0]!.steps![0]!.op).toBe("lend");
    expect(res.candidates[0]!.steps![0]!.amount).toBe("20");

    // The deposit part is reported in rejected with accountRequired
    expect(res.rejected.some((r) => r.accountRequired?.code === "accountRequired" && r.accountRequired.actions.includes("Deposit XLM"))).toBe(true);
  });

  it("mixed clarify filters out margin-needing actions when smartAccount is null", () => {
    const missing = [
      { op: "lend" as const, asset: "BLUSDC", slots: ["amount"] as ("asset" | "venue" | "amount")[], sourceQuote: "lend blusdc" },
      { op: "deposit_collateral" as const, asset: "XLM", slots: ["amount"] as ("asset" | "venue" | "amount")[], sourceQuote: "deposit xlm" },
    ];
    // With smartAccount: false (hasMarginAccount = false)
    const built = buildQuestionnaireSet(missing, observations, NOW, ["lend blusdc and deposit xlm"], [], false);
    expect(built?.sections).toHaveLength(1);
    expect(built?.sections?.[0].title).toBe("Lend BLUSDC");
  });

  it("researchTurn wires clarify stated actions through to question.stated", async () => {
    const mcp = {
      call: async (tool: string) => {
        if (tool === "vanna_resolve_account") {
          return { status: "found_on_chain", smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C" };
        }
        if (tool === "vanna_list_my_wallet_bindings") {
          return { has_assertion: true, sub: `stellar:${TRADER}`, bindings: [{ wallet_address: TRADER, active: true }] };
        }
        if (tool === "vanna_read_wallet_balances") {
          return { assets: [{ symbol: "XLM", balance: "1000", decimals: 7 }, { symbol: "USDC", balance: "400", decimals: 7 }] };
        }
        return {};
      },
    };

    const message = "lend 20 blusdc and deposit xlm";
    const result = await researchTurn(
      { message, wallet: TRADER, continuation: null },
      {
        subject: `stellar:${TRADER}`,
        server: "test",
        network: "testnet",
        secret: "a".repeat(64),
        mcp,
        signal: new AbortController().signal,
        model: async () => ({
          kind: "clarify",
          question: "How much XLM would you like to deposit?",
          actions: [
            { op: "lend", asset: "BLUSDC", sizing: { kind: "literal", amount: "20", sourceQuote: "20" }, sourceQuote: "lend 20 blusdc" },
          ],
          missing: [
            { op: "deposit_collateral", asset: "XLM", slots: ["amount"], sourceQuote: "deposit xlm" },
          ],
        }),
      },
    );

    expect(result.status).toBe("needs_input");
    expect(result.questionnaire).toBeDefined();
    expect(result.questionnaire?.sections).toHaveLength(1);
    expect(result.questionnaire?.stated).toHaveLength(1);
    expect(result.questionnaire?.stated?.[0].action.op).toBe("lend");
  });
  it("lend 20 blusdc and deposit xlm with no margin account does not invent Lend 20 XLM and blocks deposit with accountRequired", async () => {
    const NO_ACCOUNT_TRADER = "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5";
    const mcp = {
      call: async (tool: string) => {
        if (tool === "vanna_resolve_account") {
          return { status: "required", smart_account: null };
        }
        if (tool === "vanna_list_my_wallet_bindings") {
          return { has_assertion: true, sub: `stellar:${NO_ACCOUNT_TRADER}`, bindings: [{ wallet_address: NO_ACCOUNT_TRADER, active: true }] };
        }
        if (tool === "vanna_read_wallet_balances") {
          return { assets: [{ symbol: "XLM", balance: "1000", decimals: 7 }, { symbol: "BLUSDC", balance: "400", decimals: 7 }] };
        }
        if (tool === "vanna_get_asset_price") {
          return { price: "1", decimals: 7 };
        }
        if (tool === "vanna_read_earn_market") {
          return { supply_apr_pct: "5", borrow_apr_pct: "8", utilization_pct: "10" };
        }
        return {};
      },
    };

    const message = "lend 20 blusdc and deposit xlm";
    const result = await researchTurn(
      { message, wallet: NO_ACCOUNT_TRADER, continuation: null },
      {
        subject: `stellar:${NO_ACCOUNT_TRADER}`,
        server: "test",
        network: "testnet",
        secret: "a".repeat(64),
        mcp,
        signal: new AbortController().signal,
        model: async () => ({
          kind: "clarify",
          question: "How much XLM would you like to deposit?",
          actions: [
            { op: "lend", asset: "BLUSDC", sizing: { kind: "literal", amount: "20", sourceQuote: "20" }, sourceQuote: "lend 20 blusdc" },
          ],
          missing: [
            { op: "deposit_collateral", asset: "XLM", slots: ["amount"], sourceQuote: "deposit xlm" },
          ],
        }),
      },
    );

    // No questionnaire because deposit was dropped and lend has no missing slots
    expect(result.questionnaire).toBeUndefined();
    // Lend 20 BLUSDC is offered as requested steps or feasible candidate
    const feasibleOps = result.candidates?.feasible.flatMap((c) => c.steps?.map((s) => s.op) ?? []) ?? [];
    // Lend 20 XLM was NOT invented
    const lendXlmCandidate = result.candidates?.feasible.find((c) => c.steps?.some((s) => s.op === "lend" && s.args?.symbol === "XLM"));
    expect(lendXlmCandidate).toBeUndefined();
    // The deposit was blocked with accountRequired
    expect(result.candidates?.rejected.some((r) => r.accountRequired?.code === "accountRequired" && r.accountRequired.actions.includes("Deposit XLM"))).toBe(true);
    // Open a margin account choice is offered
    expect(result.choices?.some((c) => c.id === "create_account")).toBe(true);
  });
});
