/** Exact non-negative arithmetic. Never supply fallback prices or balances. */
export const ZERO = BigInt(0);
export const ONE = BigInt(1);
export const WAD = BigInt(10) ** BigInt(18);
const MAX = (ONE << BigInt(256)) - ONE;
export function uint256(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value)) throw new Error("invalid_integer");
  const result = BigInt(value);
  if (result > MAX) throw new Error("integer_overflow");
  return result;
}
export function checked(value: bigint): bigint {
  if (value < ZERO || value > MAX) throw new Error("integer_overflow");
  return value;
}
export function mulDown(a: bigint, b: bigint, divisor = WAD): bigint {
  if (divisor <= ZERO) throw new Error("invalid_divisor");
  return checked(a * b) / divisor;
}
/** Read decimal evidence without losing digits to binary floats. */
export function decimalWad(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d{1,40}(?:\.\d{1,18})?$/.test(value)) throw new Error("invalid_decimal");
  const [whole, fraction = ""] = value.split(".");
  return checked(BigInt(whole) * WAD + BigInt(fraction.padEnd(18, "0")));
}
export function formatWad(value: bigint): string {
  const sign = value < ZERO ? "-" : "";
  const abs = value < ZERO ? -value : value;
  const fraction = (abs % WAD).toString().padStart(18, "0").replace(/0+$/, "");
  return `${sign}${abs / WAD}${fraction ? `.${fraction}` : ""}`;
}
