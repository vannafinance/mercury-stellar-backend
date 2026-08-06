import { describe, expect, it } from "vitest";
import { envelopeRequiresSigner } from "@/components/copilot/sign-xdr";

describe("envelopeRequiresSigner", () => {
  const trader = "G" + "A".repeat(55);
  const faucet = "G" + "B".repeat(55);

  it("accepts normal MCP writes where tx.source is the trader", () => {
    expect(
      envelopeRequiresSigner({ source: trader, operations: [{}, {}] }, trader),
    ).toBe(true);
  });

  it("accepts Blend/Aquarius faucet envelopes where trader is only an op source", () => {
    expect(
      envelopeRequiresSigner(
        {
          source: faucet,
          operations: [{ source: trader }, { source: faucet }],
        },
        trader,
      ),
    ).toBe(true);
  });

  it("rejects a true wallet mismatch", () => {
    const other = "G" + "C".repeat(55);
    expect(
      envelopeRequiresSigner({ source: faucet, operations: [{ source: trader }] }, other),
    ).toBe(false);
  });
});
