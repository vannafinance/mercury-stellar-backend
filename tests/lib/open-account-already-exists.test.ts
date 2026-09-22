import { describe, expect, it } from "vitest";
import { createAccountStructured } from "@/lib/copilot/handle-read";

/**
 * Reporting a submission that never happened.
 *
 * Live, 22 Sep: "open a margin account", on a trader who already had one, answered
 * "Margin account opened." MCP had opened nothing — `vanna_open_account` is idempotent
 * and returns `status: "already_exists"` when `discover_active_smart_account` finds an
 * existing C-address (`account_tools.py`), precisely so the caller need not guess.
 *
 * The card guessed anyway, from three phrases in the summary prose, and MCP has TWO
 * already-exists branches. The first matches all three by luck. The recovery branch —
 * taken when create_account's simulation trips and on-chain storage is re-read, which
 * is the stronger evidence of the two — says "Treating as existing account" and matched
 * none of them.
 */

const TRADER = "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA";
const SMART = "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C";

const opts = { trader: TRADER, smartAccount: SMART, txHash: null };

/** The branch MCP takes when storage already lists an account. */
const discovered = {
  status: "already_exists",
  smart_account: SMART,
  wallet_address: TRADER,
  summary:
    `Trader ${TRADER.slice(0, 8)}… already has margin smart account ${SMART}. ` +
    "create_account was NOT submitted (one-account-per-trader). " +
    "Use this C-address for deposit/borrow/farm.",
};

/** The recovery branch: the simulation tripped, on-chain storage settled it. */
const recovered = {
  status: "already_exists",
  smart_account: SMART,
  wallet_address: TRADER,
  summary:
    `create_account simulation failed, but on-chain storage lists ${SMART} for ` +
    `${TRADER.slice(0, 8)}…. Treating as existing account.`,
  simulation_error: "UnreachableCodeReached",
};

describe("THE LIVE BUG: an account that already existed reported as opened", () => {
  it("says so for the recovery branch, whose wording matched no phrase", () => {
    const answer = createAccountStructured(recovered.summary, recovered, opts);
    expect(answer.headline).toMatch(/already have a margin account/i);
    expect(answer.headline).not.toMatch(/opened/i);
  });

  it("still says so for the branch that happened to match the prose", () => {
    const answer = createAccountStructured(discovered.summary, discovered, opts);
    expect(answer.headline).toMatch(/already have a margin account/i);
  });

  it("marks the status fact as already open, not opened on-chain", () => {
    const answer = createAccountStructured(recovered.summary, recovered, opts);
    const status = answer.facts.find((fact) => fact.label === "status");
    expect(status?.value).toBe("already open");
    expect(status?.tone).toBe("warn");
  });

  /**
   * `status` is read for what it says, not for being present — a real open still
   * reports as one, or this trades a false success for a false refusal.
   */
  it("still reports a genuine open as opened", () => {
    const answer = createAccountStructured(
      "Margin smart account created.",
      { status: "done", smart_account: SMART, wallet_address: TRADER },
      { ...opts, txHash: "abc123def456" },
    );
    expect(answer.headline).toMatch(/Margin account opened/i);
    expect(answer.facts.find((fact) => fact.label === "status")?.value).toBe("opened on-chain");
  });
});
