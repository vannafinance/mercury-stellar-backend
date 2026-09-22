import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

/**
 * "Remove my position" is an instruction, not a question about the position.
 *
 * Live, 22 Sep: "remove xlm blend position" answered with the position's balances and
 * "To remove or withdraw this position, initiate a withdrawal transaction through the
 * Vanna interface or smart account" — a read, and a dead end, for a sentence whose
 * first word is a verb. "remove my earn position" and "withdraw my entire blend
 * position" did the same.
 *
 * The noun decided the sentence, from both sides at once:
 *
 * - the position READS are guarded by `!actsOnPosition`, whose verb list held `close`,
 *   `exit` and `unwind` but neither `remove` nor `withdraw`
 * - and the Blend WRITE excluded any sentence containing "position" outright, to stop a
 *   read being mistaken for a write
 *
 * So the read let it in and the write shut it out. `remove my lp position` escaped only
 * because the LP branch is ordered earlier — one venue working and the others not is
 * what gave the missing vocabulary away.
 *
 * Fixed by giving both sides the SAME exit vocabulary (`POSITION_EXIT_VERBS`), so a
 * venue's exit branch and the read guard cannot disagree about which words mean "take
 * it out".
 */

type Routed = { kind: string; op?: string; template_id?: string; fraction?: number | null };
const route = (message: string) => routeMessage(message) as Routed;

describe("THE LIVE BUG: removing a position answered with a read", () => {
  const WHOLE_POSITION_EXITS = [
    "remove xlm blend position",
    "remove my xlm blend position",
    "withdraw my entire blend position",
    "withdraw all of my XLM Blend position",
  ];

  for (const message of WHOLE_POSITION_EXITS) {
    it(`"${message}" withdraws from Blend, sized to the whole position`, () => {
      const routed = route(message);
      expect(routed.kind).toBe("write");
      expect(routed.op).toBe("withdraw_from_blend");
      expect(routed.fraction).toBe(1);
    });
  }

  /**
   * This one also named the wrong venue before — "withdraw all of my XLM Blend
   * position" staged `withdraw_collateral`, taking margin collateral rather than the
   * Blend supply it named.
   */
  it("does not reach for margin collateral when Blend is named", () => {
    expect(route("withdraw all of my XLM Blend position").op).not.toBe("withdraw_collateral");
  });

  /**
   * Earn spans several assets, so naming none leaves a real question — but it must be
   * the redeem question, not the generic "here is what I can do" blurb it used to get.
   */
  it("treats an Earn exit as an exit, and asks which asset", () => {
    expect(route("remove my earn position").template_id).toBe("redeem_amount_and_asset");
  });

  it("keeps the LP exit that already worked", () => {
    const routed = route("remove my lp position");
    expect(routed.op).toBe("remove_liquidity");
    expect(routed.fraction).toBe(1);
  });

  it("keeps a sized exit sized", () => {
    const routed = route("remove 10 xlm in blend xlm pool");
    expect(routed.op).toBe("withdraw_from_blend");
    expect(routed.fraction).toBeNull();
  });
});

/**
 * The reads are the reason the exclusions existed. Widening the exit vocabulary must
 * not turn a question into a write — a sentence with no exit verb is still a question.
 */
describe("asking about a position is still a question", () => {
  const READS: Array<[string, string]> = [
    ["what is my blend position", "query_farm_position"],
    ["what is my earn position", "query_earn_position"],
    ["show my farm position", "query_farm_position"],
    ["what is my total supply in earn section", "query_earn_position"],
  ];

  for (const [message, template] of READS) {
    it(`"${message}" still reads`, () => {
      const routed = route(message);
      expect(routed.kind).toBe("read");
      expect(routed.template_id).toBe(template);
    });
  }

  /** A capability question contains "withdraw" and is still not an instruction. */
  it("keeps 'can i withdraw' a question", () => {
    expect(route("can i withdraw 100 XLM").kind).toBe("read");
  });
});
