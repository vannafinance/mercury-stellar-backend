/**
 * Deterministic plain-English summarizer for MCP read results.
 * Prefer human-readable / *_pct / *_usd fields; never invent numbers.
 */

import { isVerboseSignServiceDump } from "./execution-copy";

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function fmt(n: number, digits = 4): string {
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function pick(data: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (data[k] != null && data[k] !== "") return data[k];
  }
  return undefined;
}

export function explainRead(tool: string, data: Record<string, unknown>, question: string): string {
  if (data.error) {
    return `I couldn't complete that read: ${String(data.message ?? data.error)}.`;
  }

  switch (tool) {
    case "vanna_get_price": {
      const symbol = String(pick(data, ["symbol"]) ?? "asset");
      const price = pick(data, ["price_usd", "price"]);
      const stale = data.is_stale === true ? " (oracle marked stale)" : "";
      const n = num(price);
      return n != null
        ? `${symbol} is trading at $${fmt(n, 6)} USD${stale}.`
        : `${symbol} price: ${String(price)}${stale}.`;
    }
    case "vanna_get_prices_batch":
    case "vanna_get_prices": {
      const prices = (data.prices ?? data) as Record<string, unknown>;
      const parts: string[] = [];
      for (const [sym, val] of Object.entries(prices)) {
        if (!val || typeof val !== "object") continue;
        const p = num((val as Record<string, unknown>).price_usd);
        if (p != null) parts.push(`${sym} $${fmt(p, 6)}`);
      }
      return parts.length ? `Current prices: ${parts.join(", ")}.` : "No prices returned.";
    }
    case "vanna_get_pool_stats": {
      const sym = String(pick(data, ["pool_symbol", "symbol"]) ?? "pool");
      const supply = pick(data, ["supply_apy_pct", "supply_apr_pct", "supply_apy"]);
      const borrow = pick(data, ["borrow_apr_pct", "borrow_apr"]);
      const util = pick(data, ["utilization_pct", "utilization"]);
      const liq = pick(data, ["total_liquidity_human", "available_liquidity_human"]);
      const bits: string[] = [`The ${sym} pool`];
      const s = num(supply);
      const b = num(borrow);
      const u = num(util);
      if (s != null) bits.push(`supply APY ~${fmt(s, 2)}%`);
      if (b != null) bits.push(`borrow APR ~${fmt(b, 2)}%`);
      if (u != null) bits.push(`utilization ~${fmt(u, 2)}%`);
      if (liq != null) bits.push(`liquidity ~${liq}`);
      if (bits.length === 1) return `Pool stats for ${sym}: ${JSON.stringify(data).slice(0, 280)}`;
      return `${bits[0]} — ${bits.slice(1).join(", ")}.`;
    }
    case "vanna_get_account_health": {
      // Live MCP returns collateral_usd / debt_usd / ltv_ratio / is_healthy —
      // not always a bare `health_factor`. Derive HF when missing.
      const col = num(pick(data, ["collateral_usd", "total_collateral_usd", "collateral", "gross_collateral_usd"]));
      const debt = num(pick(data, ["debt_usd", "total_debt_usd", "debt"]));
      const ltv = num(pick(data, ["ltv_ratio", "ltv"]));
      const lt = num(pick(data, ["liquidation_threshold"])) ?? 0.909;
      let hf = num(pick(data, ["health_factor", "hf", "avg_health_factor"]));
      if (hf == null && col != null && debt != null && debt > 0) {
        hf = (col * lt) / debt;
      } else if (hf == null && (debt == null || debt === 0)) {
        hf = null; // ∞
      }
      const healthy = data.is_healthy;
      const dist = num(pick(data, ["distance_to_liquidation"]));
      const parts: string[] = [];
      if (hf != null) {
        // Very high HF usually means almost no debt (e.g. $2 coll / $0.05 debt ≈ 36×).
        // That is healthy, not a bug — call it out so 39.6 doesn't look "wrong".
        if (hf >= 50) {
          parts.push(
            `health factor ${fmt(hf, 1)} (extreme only because debt is dust vs collateral — fully healthy, not a bug)`,
          );
        } else if (hf >= 10) {
          parts.push(
            `health factor ${fmt(hf, 2)} (very high because debt is tiny vs collateral — still healthy)`,
          );
        } else {
          parts.push(`health factor ${fmt(hf, 2)}`);
        }
      } else if (debt === 0 || debt == null) {
        parts.push("no debt (health factor effectively ∞)");
      }
      if (col != null) parts.push(`collateral ~$${fmt(col, 2)}`);
      if (debt != null) parts.push(`debt ~$${fmt(debt, 2)}`);
      if (ltv != null) parts.push(`LTV ${(ltv * 100).toFixed(1)}%`);
      if (typeof healthy === "boolean") parts.push(healthy ? "healthy" : "at risk");
      if (dist != null) parts.push(`distance to liquidation ${(dist * 100).toFixed(1)}%`);
      return parts.length
        ? `Your account: ${parts.join(", ")}.`
        : "Account health data returned, but no numeric fields I could summarize.";
    }
    case "vanna_get_collateral": {
      const total = pick(data, ["total_value_usd", "total_collateral_usd"]);
      const list = data.collateral;
      if (Array.isArray(list) && list.length) {
        const parts = list.slice(0, 6).map((item) => {
          if (!item || typeof item !== "object") return String(item);
          const o = item as Record<string, unknown>;
          const sym = o.symbol ?? o.asset ?? "";
          const amt = o.balance ?? o.amount_human ?? o.amount ?? "";
          const usd = o.value_usd ?? o.usd;
          return usd != null ? `${sym} ${amt} (~$${usd})` : `${sym} ${amt}`;
        });
        return `Your collateral: ${parts.join(", ")}${total != null ? ` · total ~$${total}` : ""}.`;
      }
      return summarizeList("collateral", data, ["collateral", "balances", "positions"]);
    }
    case "vanna_get_debt": {
      const list = data.debt ?? data.borrows;
      if (Array.isArray(list) && list.length) {
        const parts = list.slice(0, 6).map((item) => {
          if (!item || typeof item !== "object") return String(item);
          const o = item as Record<string, unknown>;
          const sym = o.symbol ?? o.asset ?? "";
          const amt = o.balance ?? o.amount_human ?? o.amount ?? "";
          const usd = o.value_usd ?? o.usd;
          return usd != null ? `${sym} ${amt} (~$${usd})` : `${sym} ${amt}`;
        });
        return `Your debt: ${parts.join(", ")}.`;
      }
      return summarizeList("debt", data, ["debt", "borrows", "positions"]);
    }
    case "vanna_can_borrow": {
      const allowed = data.allowed ?? data.can_borrow;
      const max = pick(data, ["max_borrow_human", "max_borrow", "max_borrowable"]);
      return `Borrow check: ${allowed === false ? "not allowed" : "allowed"}${max != null ? ` (max ~${max})` : ""}.`;
    }
    case "vanna_can_withdraw": {
      const allowed = data.allowed ?? data.can_withdraw;
      const max = pick(data, ["max_withdraw_human", "max_withdraw"]);
      return `Withdraw check: ${allowed === false ? "not allowed" : "allowed"}${max != null ? ` (max ~${max})` : ""}.`;
    }
    case "vanna_get_max_borrow": {
      const max = pick(data, ["max_borrow_human", "max_borrow", "amount_human"]);
      const s = pick(data, ["symbol"]);
      return `Max borrow${s ? ` (${s})` : ""}: ${max ?? JSON.stringify(data).slice(0, 120)}.`;
    }
    case "vanna_list_protocol_addresses": {
      const keys = Object.keys(data).filter((k) => typeof data[k] === "string").slice(0, 6);
      return keys.length
        ? `Protocol addresses include: ${keys.map((k) => `${k}=${String(data[k]).slice(0, 8)}…`).join(", ")}.`
        : "Protocol address list returned.";
    }
    case "vanna_get_collateral_config": {
      const list = data.allowed_collateral;
      if (Array.isArray(list)) {
        const ok = list
          .filter((x: any) => x?.allowed)
          .map((x: any) => x.symbol)
          .join(", ");
        return `Allowed collateral: ${ok || "none listed"}.`;
      }
      return "Collateral config returned.";
    }
    case "vanna_get_vtoken_exchange_rate": {
      const s = pick(data, ["symbol"]);
      const rate = pick(data, ["exchange_rate", "exchange_rate_human"]);
      return `${s ?? "Asset"} vToken exchange rate: ${rate ?? "n/a"}.`;
    }
    case "vanna_list_blend_reserves":
    case "vanna_get_blend_reserve_stats": {
      const s = pick(data, ["symbol"]);
      const supply = pick(data, ["supply_apy_pct", "supply_apr_pct"]);
      const borrow = pick(data, ["borrow_apy_pct", "borrow_apr_pct"]);
      if (s || supply || borrow) {
        return `Blend${s ? ` ${s}` : ""}: supply APY ${supply ?? "n/a"}%, borrow APY ${borrow ?? "n/a"}%.`;
      }
      const count = pick(data, ["count"]);
      return `Blend reserves${count != null ? ` (${count})` : ""} returned.`;
    }
    case "vanna_resolve_account": {
      const sa = pick(data, ["smart_account", "account", "margin_account"]);
      return sa ? `Resolved smart account: ${sa}.` : "No smart account found for that wallet.";
    }
    default: {
      // Generic: flatten a few top-level scalar facts
      const facts: string[] = [];
      for (const [k, v] of Object.entries(data)) {
        if (v == null || typeof v === "object") continue;
        if (/wad|raw|address/i.test(k)) continue;
        facts.push(`${k.replace(/_/g, " ")}: ${v}`);
        if (facts.length >= 6) break;
      }
      if (facts.length) return `Here's what I found for “${question.slice(0, 60)}”: ${facts.join("; ")}.`;
      return `Received data for ${tool}, but no human-readable fields to summarize.`;
    }
  }
}

function summarizeList(label: string, data: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const arr = data[k];
    if (Array.isArray(arr)) {
      if (!arr.length) return `No ${label} positions found.`;
      const parts = arr.slice(0, 5).map((item) => {
        if (!item || typeof item !== "object") return String(item);
        const o = item as Record<string, unknown>;
        const sym = o.symbol ?? o.asset ?? "";
        const amt = o.amount_human ?? o.amount ?? o.usd ?? "";
        return `${sym} ${amt}`.trim();
      });
      return `Your ${label}: ${parts.join(", ")}.`;
    }
  }
  // scalar fallback
  const facts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v == null || typeof v === "object") continue;
    facts.push(`${k}: ${v}`);
    if (facts.length >= 5) break;
  }
  return facts.length ? `Your ${label}: ${facts.join(", ")}.` : `No ${label} data available.`;
}

/** Flatten nested objects for the UI facts panel; drop huge wads. */
export function factsForUi(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Prefer human fields from live MCP health payload
  const col = num(pick(data, ["collateral_usd", "total_collateral_usd", "total_value_usd"]));
  const debt = num(pick(data, ["debt_usd", "total_debt_usd"]));
  const ltv = num(pick(data, ["ltv_ratio", "ltv"]));
  const lt = num(pick(data, ["liquidation_threshold"])) ?? 0.909;
  let hf = num(pick(data, ["health_factor", "hf", "avg_health_factor"]));
  if (hf == null && col != null && debt != null && debt > 0) hf = (col * lt) / debt;
  if (hf != null) out["health factor"] = Number(hf.toFixed(3));
  else if (debt === 0 || (debt == null && col != null)) out["health factor"] = "∞";
  if (col != null) out["collateral usd"] = Number(col.toFixed(2));
  if (debt != null) out["debt usd"] = Number(debt.toFixed(2));
  if (ltv != null) out["ltv %"] = Number((ltv * 100).toFixed(2));
  if (typeof data.is_healthy === "boolean") out["healthy"] = data.is_healthy;

  /**
   * Drop a raw field when MCP also sent the formatted one.
   *
   * MCP returns pairs — `total_liquidity` (a bare 18-decimal wad integer) beside
   * `total_liquidity_human` ("22,219.1975"). The `_wad`/`_raw` suffix filter below never
   * matched the first of those, so the facts panel rendered both:
   *
   *   TOTAL LIQUIDITY        22219197454400000000000
   *   TOTAL LIQUIDITY HUMAN  22,219.1975
   *
   * The unreadable one comes first, so the eye lands on it, and the same figure appearing
   * twice in two magnitudes reads like the copilot disagreeing with itself. The Earn page
   * shows only the formatted number; this makes the panel match.
   */
  const hasHumanTwin = new Set(
    Object.keys(data)
      .filter((k) => /_human$/i.test(k))
      .map((k) => k.replace(/_human$/i, "")),
  );

  /** A 15+ digit integer is a wad however it was spelled — last-resort guard. */
  const isRawWad = (v: unknown): boolean =>
    (typeof v === "string" && /^\d{15,}$/.test(v)) ||
    (typeof v === "number" && Number.isInteger(v) && Math.abs(v) >= 1e15);

  for (const [k, v] of Object.entries(data)) {
    if (v == null) continue;
    if (/_wad$|_raw$|address$|unsigned_xdr|auth_entries|balance_source/i.test(k)) continue;
    if (hasHumanTwin.has(k) || isRawWad(v)) continue;
    /**
     * MCP's own receipt paragraph is not a fact.
     *
     * `sanitizeExecutionProse` already strips it from the message body, but the facts
     * panel echoed the same string verbatim under `summary` — which is how "New smart
     * account: CDNGNL…" reached the screen for an account that had existed for days, next
     * to a duplicate of the tx hash and explorer link the card renders as its own fields.
     * The dump is redundant here by construction, so it is dropped rather than trimmed.
     */
    if (typeof v === "string" && isVerboseSignServiceDump(v)) continue;
    if (Array.isArray(v)) {
      // Flatten first few position rows: "XLM balance", "XLM value_usd"
      v.slice(0, 6).forEach((item, i) => {
        if (!item || typeof item !== "object") return;
        const o = item as Record<string, unknown>;
        const sym = String(o.symbol ?? o.asset ?? i);
        if (o.balance != null) out[`${sym} balance`] = o.balance;
        if (o.amount != null && o.balance == null) out[`${sym} amount`] = o.amount;
        if (o.value_usd != null) out[`${sym} usd`] = o.value_usd;
      });
      continue;
    }
    if (typeof v === "object") {
      const nested = v as Record<string, unknown>;
      for (const [sk, sv] of Object.entries(nested)) {
        if (sv == null || typeof sv === "object") continue;
        if (/_wad$|_raw$/i.test(sk)) continue;
        if (out[`${k}.${sk}`] == null && out[prettyFactKey(sk)] == null) {
          out[`${prettyFactKey(k)} ${prettyFactKey(sk)}`] = sv;
        }
      }
    } else if (
      out[k] == null &&
      out[prettyFactKey(k)] == null &&
      !["collateral_usd", "debt_usd", "ltv_ratio", "health_factor", "is_healthy", "liquidation_threshold", "borrow_threshold", "total_value_usd"].includes(k)
    ) {
      out[prettyFactKey(k)] = v;
    }
  }
  return out;
}

function prettyFactKey(k: string): string {
  return k.replace(/_/g, " ").trim();
}
