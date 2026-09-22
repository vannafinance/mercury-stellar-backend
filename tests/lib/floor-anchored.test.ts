/**
 * The floor is the user's number, located by the model and verified against the user's
 * own words — not re-parsed from their sentence by a regex list.
 *
 * ## The live failure this pins
 *
 * 13 Sep: "Create a strategy so my HF stays above 1.3 …". The model put "Maintain health
 * factor above 1.3" on the card. The regex parser knew "keep/maintain … above" but not
 * "stays above", so code saw NO floor, and every borrow plan was ruled out with "a borrow
 * needs the health-factor floor you want kept". Understanding is the model's; the number
 * is anchored in code.
 */
import { describe, expect, it } from "vitest";
import { anchoredGoalFloor, statedFloorFrom } from "@/lib/copilot/investigation/floor";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import { autoSignRefusal, preBroadcastRejection } from "@/lib/copilot/investigation/execute";

const PROMPT = "Create a strategy so my HF stays above 1.3, use USDC and XLM as collateral and deploy them in farm, you can borrow";

describe("anchoredGoalFloor", () => {
  it("accepts the model's floor when its quote is in the user's message and contains the number", () => {
    expect(anchoredGoalFloor({ healthFactorFloor: { value: "1.3", sourceQuote: "HF stays above 1.3" } }, [PROMPT])).toBe("1.3");
  });
  it("rejects a quote the user never wrote, and a quote that does not contain the value", () => {
    expect(anchoredGoalFloor({ healthFactorFloor: { value: "1.3", sourceQuote: "keep HF above 1.3" } }, [PROMPT])).toBeNull();
    expect(anchoredGoalFloor({ healthFactorFloor: { value: "1.5", sourceQuote: "HF stays above 1.3" } }, [PROMPT])).toBeNull();
    expect(anchoredGoalFloor({}, [PROMPT])).toBeNull();
  });
  it("is the path that catches phrasings the regex list does not", () => {
    // Documents the gap, so nobody 'fixes' it by adding another regex.
    expect(statedFloorFrom([PROMPT])).toBeNull();
    expect(anchoredGoalFloor({ healthFactorFloor: { value: "1.3", sourceQuote: "stays above 1.3" } }, [PROMPT])).toBe("1.3");
  });
});

describe("statedFloorFrom", () => {
  it("never turns 'avoid liquidation' into a number", () => {
    expect(statedFloorFrom(["deploy my XLM but don't get liquidated"])).toBeNull();
    expect(statedFloorFrom(["keep my health factor above 1.25 please"])).toBe("1.25");
  });
});

describe("parseDecision healthFactorFloor", () => {
  const base = { kind: "research_complete", findings: [{ summary: "s", evidenceIds: ["e1"] }], openQuestions: [] };
  const goal = (floor: unknown) => ({ intent: "strategy", objective: "o", constraints: [], borrowing: "allowed", healthFactorFloor: floor });
  it("keeps a literal floor with its quote", () => {
    const d = parseDecision({ ...base, goal: goal({ value: "1.3", sourceQuote: "HF stays above 1.3" }) });
    expect(d?.kind === "research_complete" && d.goal.healthFactorFloor).toEqual({ value: "1.3", sourceQuote: "HF stays above 1.3" });
  });
  it.each([
    ["a non-decimal", { value: "one point three", sourceQuote: "one point three" }],
    ["a quote without the number", { value: "1.3", sourceQuote: "stay safe" }],
    ["an extra key", { value: "1.3", sourceQuote: "above 1.3", inferred: true }],
    ["a bare number", "1.3"],
  ])("drops %s without voiding the decision", (_name, floor) => {
    const d = parseDecision({ ...base, goal: goal(floor) });
    expect(d?.kind).toBe("research_complete");
    expect(d?.kind === "research_complete" && d.goal.healthFactorFloor).toBeUndefined();
  });
});

/**
 * A budget the user armed, refusing a spend they set the limit for, is the budget
 * working — but only if they are told which limit and how to move it. The card used to
 * say "sign this in your wallet" for a blown cap, a dead session and an unallowlisted
 * contract alike, which sends someone who armed a budget precisely to avoid the popup
 * back to the popup, unable to tell which of their own caps stopped it.
 */
describe("autoSignRefusal", () => {
  it("passes the Sign Service's reason through when auto sign refused", () => {
    expect(autoSignRefusal({
      auto_sign: "rejected",
      reason: "over_daily_cap",
      message: "The Sign Service refused to sign (policy: over_daily_cap). Nothing was signed.",
    })).toMatch(/over_daily_cap/);
  });

  it("is silent when auto sign signed it, or was never armed", () => {
    expect(autoSignRefusal({ auto_sign: "on", message: "signed" })).toBeNull();
    expect(autoSignRefusal({ message: "no verdict here" })).toBeNull();
  });

  it("adds nothing of its own when the refusal carried no message", () => {
    expect(autoSignRefusal({ auto_sign: "rejected", reason: "over_per_tx_cap" })).toBeNull();
  });
});

describe("preBroadcastRejection", () => {
  it("names the MCP's reason for an envelope it classified inside the tool", () => {
    // The 13 Sep deposit: keys error, message, code, contract_diagnostic, reason — no tx_hash.
    const build = { error: "simulation_failed", message: "On-chain simulation rejected the transaction: balance too low", code: "3", contract_diagnostic: "…", reason: "insufficient_balance_or_allowance" };
    expect(preBroadcastRejection(build, null)).toBe("Not submitted — the protocol rejected this step before broadcast: On-chain simulation rejected the transaction: balance too low");
  });
  it("falls back to error and reason when there is no message", () => {
    expect(preBroadcastRejection({ error: "health_check_failed", reason: "ltv_too_high" }, null)).toMatch(/health_check_failed \(ltv too high\)/);
  });
  /**
   * A Freighter wallet has no Sign Service session, so every write it makes comes back
   * from `maybe_auto_sign` exactly like this: the built envelope, `signing_status:
   * "needs_wallet_sign"`, and the reason auto-sign was unavailable in `error`/`reason`.
   * Reading that as a rejection threw the signable transaction away and showed the MCP's
   * own signing instructions to the user as a protocol refusal (21 Sep, live, non-Privy
   * wallet, "swap 100 XLM to AQUSDC"). The wallet can still sign it; nothing was refused.
   */
  it("is silent when the envelope is still signable, whatever the auto-sign reason says", () => {
    const build = {
      unsigned_xdr: "A".repeat(8188),
      has_unsigned_xdr: true,
      signing_status: "needs_wallet_sign",
      auto_sign: "rejected",
      reason: "wallet_not_bound",
      error: "wallet_not_bound",
      message: "FULL unsigned envelope is in tool result field unsigned_xdr (8188 chars). Sign it in Freighter/wallet — do not invent a hash.",
    };
    expect(preBroadcastRejection(build, null)).toBeNull();
  });

  it("still reports a classified failure that produced no envelope to sign", () => {
    const build = {
      signing_status: "no_xdr", error: "simulation_failed", reason: "insufficient_balance_or_allowance",
      message: "On-chain simulation rejected the transaction",
    };
    expect(preBroadcastRejection(build, null)).toMatch(/rejected this step before broadcast/);
  });

  it("stays silent — uncertain — when a hash exists or the error carries no classification", () => {
    expect(preBroadcastRejection({ error: "submit_failed", message: "timeout", code: "x" }, "a".repeat(64))).toBeNull();
    expect(preBroadcastRejection({ error: "internal_error", message: "boom" }, null)).toBeNull();
    expect(preBroadcastRejection({ unsigned_xdr: "AAAA" }, null)).toBeNull();
  });
});
