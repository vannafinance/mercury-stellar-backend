/**
 * A read is either usable, or unavailable with a reason.
 *
 * Failed or empty reads must not become confident zeros or verified negatives.
 * Snapshot collateral, debt pricing, and wallet bindings all go through this
 * shape so a fourth site cannot invent a third discipline.
 */

export type Usable<T> = { ok: true; value: T };
export type Unavailable = { ok: false; reason: string };
export type ReadResult<T> = Usable<T> | Unavailable;

export function usable<T>(value: T): Usable<T> {
  return { ok: true, value };
}

export function unavailable(reason: string): Unavailable {
  return { ok: false, reason };
}

export function isUsable<T>(result: ReadResult<T>): result is Usable<T> {
  return result.ok === true;
}

/**
 * Value an amount in USD. A missing, zero, or non-finite price is unavailable —
 * never `$0` of debt that is still sitting on the account.
 */
export function pricedUsd(amount: number, price: number, label: string): ReadResult<number> {
  if (!Number.isFinite(amount) || amount < 0) return unavailable(`${label}: invalid amount`);
  if (amount === 0) return usable(0);
  if (!Number.isFinite(price) || price <= 0) return unavailable(`${label}: missing or zero price`);
  return usable(amount * price);
}

/**
 * A collection that is being treated as a verified set. Empty is not evidence
 * that a member is absent — only a non-empty list can support that claim.
 */
export function claimedSet<T>(items: readonly T[], emptyReason: string): ReadResult<readonly T[]> {
  if (items.length === 0) return unavailable(emptyReason);
  return usable(items);
}

/**
 * Every identifier the source listed must have produced a row. A listed token
 * whose read failed is incomplete, not "zero of that token".
 */
export function requireListedResults<T>(
  listed: readonly string[],
  byId: Readonly<Record<string, T | undefined>>,
  missing: (id: string) => string,
): ReadResult<Record<string, T>> {
  const value: Record<string, T> = {};
  for (const id of listed) {
    const item = byId[id];
    if (item === undefined) return unavailable(missing(id));
    value[id] = item;
  }
  return usable(value);
}
