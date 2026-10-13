/** A request to review a setting. Never a signer grant or an execution instruction. */
export interface SigningPolicyRequest {
  action: "configure" | "inspect" | "disable";
  mode?: "defaults" | "custom";
  unit: "testnet_usd" | "token_units" | "unspecified";
  maxPerTx?: string;
  maxPerDay?: string;
  sourceQuote: string;
}
export function parseSigningPolicyRequest(raw: unknown): SigningPolicyRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !["action", "mode", "unit", "maxPerTx", "maxPerDay", "sourceQuote"].includes(key)) ||
    !["configure", "inspect", "disable"].includes(String(value.action)) ||
    !["testnet_usd", "token_units", "unspecified"].includes(String(value.unit)) ||
    typeof value.sourceQuote !== "string" || !value.sourceQuote.trim() || value.sourceQuote.length > 1600 ||
    (value.mode !== undefined && !["defaults", "custom"].includes(String(value.mode)))) return null;
  for (const amount of [value.maxPerTx, value.maxPerDay]) {
    if (amount !== undefined && (typeof amount !== "string" || !/^\d+(?:\.\d{1,6})?$/.test(amount) || !Number.isFinite(Number(amount)) || Number(amount) <= 0)) return null;
  }
  if ((value.maxPerTx !== undefined || value.maxPerDay !== undefined) && (value.action !== "configure" || value.mode !== "custom")) return null;
  return { action: value.action as SigningPolicyRequest["action"], unit: value.unit as SigningPolicyRequest["unit"], sourceQuote: value.sourceQuote,
    ...(value.mode ? { mode: value.mode as SigningPolicyRequest["mode"] } : {}),
    ...(value.maxPerTx !== undefined ? { maxPerTx: value.maxPerTx as string } : {}),
    ...(value.maxPerDay !== undefined ? { maxPerDay: value.maxPerDay as string } : {}) };
}
export function anchoredSigningPolicyRequest(raw: unknown, message: string): SigningPolicyRequest | null {
  const request = parseSigningPolicyRequest(raw);
  if (!request || !message.includes(request.sourceQuote)) return null;
  // Numeric validation only: intent comes from the typed model decision, never prompt keywords.
  const quoted = (request.sourceQuote.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [])
    .filter(value => /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)).map(value => Number(value.replaceAll(",", "")));
  if ([request.maxPerTx, request.maxPerDay].some(value => value !== undefined && !quoted.includes(Number(value)))) return null;
  return request;
}
