import { checked, mulDown, uint256, WAD, ZERO } from "./fixed";

/** Trusted server reads, NOT a model-facing schema. No wallet balances here. */
export type CollateralPosition = {
  kind: "recorded";
  symbol: "XLM" | "USDC" | "BLUSDC" | "AQUSDC" | "SOUSDC" | "EURC";
  balanceWad: string;
  priceWad: string;
} | {
  kind: "blend_receipt";
  symbol: "BLEND_XLM" | "BLEND_USDC" | "BLEND_EURC";
  trackingBalance: string;
  bRate: string;
  underlyingDecimals: number;
  priceWad: string;
};

/**
 * Mirrors the inspected RiskEngine's recorded-collateral and Blend receipt paths.
 * Does NOT add debt or idle borrowed proceeds. LP valuation is deliberately absent:
 * borrow guards skip LPs, while the total-balance path tries the unavailable oracle.
 * Matching arithmetic is not evidence that a proposed transaction will succeed.
 */
export function valueCollateral(positions: readonly CollateralPosition[]): {
  balanceWad: string; positions: Array<{ symbol: string; underlyingWad: string; valueWad: string }>;
} {
  const seen = new Set<string>();
  let total = ZERO;
  const values = positions.map((position) => {
    const key = position.symbol === "BLUSDC" ? "USDC" : position.symbol;
    if (seen.has(key)) throw new Error("duplicate_collateral");
    seen.add(key);
    const price = uint256(position.priceWad);
    if (price === ZERO) throw new Error("missing_price");
    let underlying: bigint;
    if (position.kind === "recorded") {
      if (!["XLM", "USDC", "BLUSDC", "AQUSDC", "SOUSDC", "EURC"].includes(position.symbol)) throw new Error("unsupported_collateral");
      underlying = uint256(position.balanceWad);
    } else if (position.kind === "blend_receipt") {
      if (!["BLEND_XLM", "BLEND_USDC", "BLEND_EURC"].includes(position.symbol)) throw new Error("unsupported_collateral");
      if (!Number.isInteger(position.underlyingDecimals) || position.underlyingDecimals < 0 || position.underlyingDecimals > 18) throw new Error("invalid_decimals");
      const rate = uint256(position.bRate);
      if (rate === ZERO) throw new Error("missing_exchange_rate");
      // Preserve both truncation steps in the contract; combining fractions differs.
      const tokens = mulDown(uint256(position.trackingBalance), rate, BigInt(10) ** BigInt(12));
      underlying = mulDown(tokens, WAD, BigInt(10) ** BigInt(position.underlyingDecimals));
    } else throw new Error("unsupported_collateral");
    const value = mulDown(underlying, price);
    total = checked(total + value);
    return { symbol: position.symbol, underlyingWad: String(underlying), valueWad: String(value) };
  });
  return { balanceWad: String(total), positions: values };
}
