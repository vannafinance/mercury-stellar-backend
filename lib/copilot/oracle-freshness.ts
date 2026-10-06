/** Reading a price now does not establish when the oracle observed it. */
export function normalizeOracleFreshness(data: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 8 || value == null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(item => walk(item, depth + 1));
    const row = value as Record<string, unknown>;
    const out = Object.fromEntries(Object.entries(row).map(([key, item]) => [key, walk(item, depth + 1)]));
    if (row.price_usd != null && row.is_stale !== true) {
      const timestamp = row.price_timestamp ?? row.timestamp;
      const numeric = typeof timestamp === "number" || typeof timestamp === "string" && /^\d+$/.test(timestamp)
        ? Number(timestamp) : NaN;
      if (!Number.isSafeInteger(numeric) || numeric <= 0 || numeric > Math.floor(Date.now() / 1000)) {
        out.is_stale = null;
        out.freshness = "unknown";
      }
    }
    return out;
  };
  return walk(data, 0) as Record<string, unknown>;
}
