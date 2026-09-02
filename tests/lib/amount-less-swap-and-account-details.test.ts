/**
 * Reported live, four related routing gaps that all fell through to the generic
 * capabilities blurb instead of being recognized:
 *
 *   11a. "In My margin account How much Interest accrued till date in BLUSDC" — no
 *        tool tracks accrued interest separately from principal at all.
 *   11b. "Now Can You Transfer Collateral Margin to Wallet 20 XLM" — the same
 *        instruction as "withdraw 20 XLM collateral", phrased with "transfer" instead
 *        of "withdraw"/"take out"/"pull".
 *   11c. "Now Can you tell me my margin account details" — names none of
 *        "position"/"holdings"/"supply"/"net worth" either.
 *   12.  "Now Can you Perform Swap From XLM to SoUSDC in Soroswap" — named both
 *        tokens and a venue but no size, so it matched neither swap branch (both
 *        required an amount or balance fraction) and never executed anything.
 */
import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

describe("a swap naming both tokens but no size is still a swap instruction", () => {
  it("routes 'Perform Swap From XLM to SoUSDC in Soroswap' to a swap write", () => {
    const r = routeMessage("Now Can you Perform Swap From XLM to SoUSDC in Soroswap");
    expect(r.kind).toBe("write");
    if (r.kind === "write") {
      expect(r.op).toBe("swap");
      expect(r.token_a).toBe("XLM");
      expect(r.token_b).toBe("SOUSDC");
      expect(r.venue).toBe("soroswap");
      expect(r.requires_amount).toBe(true);
    }
  });

  it("still routes a fully-specified swap the same as before", () => {
    const r = routeMessage("swap 10 XLM to BLUSDC");
    expect(r.kind).toBe("write");
    if (r.kind === "write") {
      expect(r.op).toBe("swap");
      expect(r.requires_amount).toBe(false);
    }
  });

  it("does not treat a bare swap capability question as an instruction to execute", () => {
    const r = routeMessage("is swap available for XLM");
    if (r.kind === "write") {
      expect(r.op).not.toBe("swap");
    }
  });
});

describe("'transfer collateral to wallet' is the same instruction as 'withdraw collateral'", () => {
  it("routes 'Transfer Collateral Margin to Wallet 20 XLM' to withdraw_collateral", () => {
    const r = routeMessage("Now Can You Transfer Collateral Margin to Wallet 20 XLM");
    expect(r.kind).toBe("write");
    if (r.kind === "write") {
      expect(r.op).toBe("withdraw_collateral");
      expect(r.amount).toBe(20);
    }
  });

  it("still excludes a bare capability question", () => {
    const r = routeMessage("can I withdraw my collateral");
    expect(r.kind).not.toBe("write");
  });
});

describe("'tell me my margin account details' answers with the full account picture", () => {
  it("routes to the whole-account fan-out", () => {
    const r = routeMessage("Now Can you tell me my margin account details");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_all_positions");
  });
});

describe("'interest accrued' is answered honestly, not fabricated", () => {
  it("routes 'how much interest accrued till date in BLUSDC' to query_accrued_interest", () => {
    const r = routeMessage("In My margin account How much Interest accrued till date in BLUSDC");
    expect(r.kind).toBe("read");
    if (r.kind === "read") {
      expect(r.template_id).toBe("query_accrued_interest");
      expect(r.args?.symbol).toBe("BLUSDC");
    }
  });

  it("still routes a plain debt question to query_debt", () => {
    const r = routeMessage("how much debt do I have");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_debt");
  });
});
