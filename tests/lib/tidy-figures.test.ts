import { describe, expect, it } from "vitest";
import { tidyFigures } from "@/lib/copilot/investigation/figures";

/**
 * 24 Oct, N3: the protocol's own refusal sentence reached the user as "Withdrawing 5863.3581524 XLM ($996.397732626120418858 USD)
 * is NOT permitted". The 18 decimals are the contract's precision, not a figure anyone reads. Dollar amounts read as dollars, a
 * token amount keeps the 7 places a Stellar token has, and anything that is not a decimal figure (a hash, an address) is left alone.
 */
describe("figures in a protocol sentence read the way a person reads them", () => {
  it("rounds a dollar amount to cents, with thousands separators", () => {
    expect(tidyFigures("($996.397732626120418858 USD)")).toBe("($996.40 USD)");
    expect(tidyFigures("worth $12345.6789")).toBe("worth $12,345.68");
  });
  it("cuts a long token amount to the 7 places of a Stellar token, dropping trailing zeros", () => {
    expect(tidyFigures("Withdrawing 5863.358152400000000000 XLM")).toBe("Withdrawing 5863.3581524 XLM");
    expect(tidyFigures("Withdrawing 12.123456789012 XLM")).toBe("Withdrawing 12.1234568 XLM");
  });
  it("leaves short figures, whole numbers, ratios and the 1.1x threshold exactly as they are", () => {
    const text = "it would leave the account below the 1.1x health threshold; balance 5863.3581524, ratio 0.909, 5,000 SoUSDC";
    expect(tidyFigures(text)).toBe(text);
  });
  it("never touches a transaction hash or an address", () => {
    const text = "tx a41732c9e3f1b27d0a5e8f4c6b9d21e3a41732c9e3f1b27d0a5e8f4c6b9d21e3 from CBOQAN5NFII4P5HD73M2IRSFYZSXC5XC76FQWQ5JU7LJAO66TFFPG5XY";
    expect(tidyFigures(text)).toBe(text);
  });
  it("is the identity on text with no decimals", () => {
    expect(tidyFigures("Nothing was executed.")).toBe("Nothing was executed.");
  });
});
