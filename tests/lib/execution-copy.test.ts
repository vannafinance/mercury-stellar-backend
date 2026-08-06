import { describe, expect, it } from "vitest";
import {
  cleanExecutionCopy,
  isVerboseSignServiceDump,
  sanitizeExecutionProse,
} from "@/lib/copilot/execution-copy";

const SIGN_DUMP =
  "Signed and submitted by the Sign Service. Tx b0253a428234f451d0dc899eac11adcfbf55ac288bd80a094061843c8dfbc578. " +
  "View: https://stellar.expert/explorer/testnet/tx/b0253a428234f451d0dc899eac11adcfbf55ac288bd80a094061843c8dfbc578 " +
  "New smart account: CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C. " +
  "Use this C-address for deposit/borrow tools.";

describe("execution-copy", () => {
  it("flags the Sign Service dump as verbose", () => {
    expect(isVerboseSignServiceDump(SIGN_DUMP)).toBe(true);
  });

  it("turns a borrow dump into a short headline + body", () => {
    const copy = cleanExecutionCopy({
      label: "Borrow 5 XLM",
      status: "signed_and_submitted",
      rawMessage: SIGN_DUMP,
      txHash: "b0253a428234f451d0dc899eac11adcfbf55ac288bd80a094061843c8dfbc578",
    });
    expect(copy.headline).toBe("Borrow 5 XLM");
    expect(copy.body).toBe("Signed and submitted on-chain.");
    expect(copy.body).not.toMatch(/stellar\.expert/);
    expect(copy.body).not.toMatch(/b0253a42/);
    expect(copy.body).not.toMatch(/CDNGNL/);
  });

  it("keeps a short non-dump note", () => {
    const copy = cleanExecutionCopy({
      label: "Repay 2 XLM",
      status: "signed_and_submitted",
      rawMessage: "Repaid from free balance.",
      txHash: "abc",
    });
    expect(copy.headline).toBe("Repay 2 XLM");
    expect(copy.body).toBe("Repaid from free balance.");
  });

  it("strips hash/url crumbs from mixed prose", () => {
    const cleaned = sanitizeExecutionProse(
      "Borrow landed. Tx b0253a428234f451d0dc899eac11adcfbf55ac288bd80a094061843c8dfbc578. " +
        "View: https://stellar.expert/explorer/testnet/tx/deadbeef",
    );
    expect(cleaned).toBe("Borrow landed.");
  });
});
