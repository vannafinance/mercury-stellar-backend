/** Pull a USD total out of an MCP collateral/debt payload without inventing keys. */
export function usdTotal(payload: unknown, kind: "collateral" | "debt"): number | null {
  if (!payload || typeof payload !== "object") return null;
  const entries = Object.entries(payload as Record<string, unknown>).map(
    ([k, v]) => [k.toLowerCase().replace(/\s+/g, "_"), v] as const,
  );
  const byKey = new Map(entries);

  const candidates =
    kind === "collateral"
      ? ["collateral_usd", "total_collateral_usd", "total_value_usd", "value_usd"]
      : ["total_debt_usd", "debt_usd", "total_borrowed_usd", "borrowed_usd"];
  for (const k of candidates) {
    const n = Number(byKey.get(k));
    if (Number.isFinite(n) && n > 0) return n;
  }

  let sum = 0;
  let seen = false;
  for (const [k, v] of entries) {
    if (!/_usd$/.test(k) || /^(total|collateral|debt|value|borrowed)_/.test(k)) continue;
    const n = Number(v);
    if (Number.isFinite(n)) {
      sum += n;
      seen = true;
    }
  }
  return seen ? sum : null;
}
