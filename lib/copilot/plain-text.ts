/**
 * The copilot writes a plain hyphen where an em dash would go.
 *
 * An em dash reads as machine-written, and the model reaches for one on its own, so this is applied to
 * everything the server sends to the client (the research view and the workflow view), not only to
 * strings this repository spells out. It touches that one character and nothing else: ids, hashes,
 * amounts and sealed tokens never contain it, so mapping every string leaf is safe.
 */
const EM_DASH = /—/g;

export function plainDashes<T>(value: T): T {
  if (typeof value === "string") return value.replace(EM_DASH, "-") as T;
  if (Array.isArray(value)) return value.map((item) => plainDashes(item)) as T;
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, plainDashes(item)])) as T;
  }
  return value;
}
