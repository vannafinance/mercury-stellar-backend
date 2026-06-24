/** Stellar SAC token precision (XLM, USDC). */
export const TOKEN_DECIMALS = 7;
const STROOP_BASE = BigInt(10 ** TOKEN_DECIMALS);
/** Leave 1 stroop on MAX / 100% so transfers never exceed on-chain balance. */
const DEFAULT_MAX_BUFFER_STROOPS = BigInt(1);

/** Parse a human token amount string into stroops (floor fractional digits). */
export function parseTokenAmountToStroops(
  amount: string,
  decimals = TOKEN_DECIMALS,
): bigint {
  const s = amount.replace(/,/g, "").trim();
  if (!s || s === ".") return BigInt(0);
  const negative = s.startsWith("-");
  const cleaned = negative ? s.slice(1) : s;
  const [whole, frac = ""] = cleaned.split(".");
  const fracPadded = frac.slice(0, decimals).padEnd(decimals, "0");
  const base = BigInt(10 ** decimals);
  const stroops = BigInt(whole || "0") * base + BigInt(fracPadded || "0");
  return negative ? -stroops : stroops;
}

/** Format stroops as a human amount (no trailing zeros). */
export function stroopsToAmountString(
  stroops: bigint,
  decimals = TOKEN_DECIMALS,
): string {
  if (stroops <= BigInt(0)) return "0";
  const base = BigInt(10 ** decimals);
  const whole = stroops / base;
  const frac = stroops % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

/** Max swappable amount from a balance string (never rounds up). */
export function getMaxSwappableBalance(
  balanceStr: string,
  bufferStroops = DEFAULT_MAX_BUFFER_STROOPS,
): string {
  let stroops = parseTokenAmountToStroops(balanceStr);
  if (stroops > bufferStroops) stroops -= bufferStroops;
  else stroops = BigInt(0);
  return stroopsToAmountString(stroops);
}

/** Amount for a balance % (100% uses the same safe max as MAX button). */
export function amountFromBalancePercent(
  balanceStr: string,
  pct: number,
  bufferStroops = DEFAULT_MAX_BUFFER_STROOPS,
): string {
  let total = parseTokenAmountToStroops(balanceStr);
  if (pct >= 100) {
    if (total > bufferStroops) total -= bufferStroops;
    else total = BigInt(0);
  } else if (pct > 0) {
    total = (total * BigInt(Math.floor(pct))) / BigInt(100);
  } else {
    total = BigInt(0);
  }
  return stroopsToAmountString(total);
}

/** Encode token stroops as WAD for AccountManager external calls (7-decimal tokens). */
export function stroopsToWad(
  stroops: bigint,
  tokenDecimals = TOKEN_DECIMALS,
): bigint {
  const scale = 18 - tokenDecimals;
  return stroops * BigInt(10 ** scale);
}

/** Floor a JS number to stroops and back (avoids float overshoot on MAX). */
export function floorAmountToStroops(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return BigInt(0);
  return BigInt(Math.floor(amount * Number(STROOP_BASE) + 1e-9));
}

export function capAmountToMaxBalance(
  amount: number,
  balanceStr: string,
  bufferStroops = DEFAULT_MAX_BUFFER_STROOPS,
): number {
  const maxStr = getMaxSwappableBalance(balanceStr, bufferStroops);
  const maxStroops = parseTokenAmountToStroops(maxStr);
  const reqStroops = floorAmountToStroops(amount);
  const use = reqStroops > maxStroops ? maxStroops : reqStroops;
  return Number(use) / Number(STROOP_BASE);
}
