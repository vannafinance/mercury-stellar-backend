import { isRecord } from "./decision";
import type { Observation } from "./types";
import type { ResearchFact } from "./view";

/** Display only fields whose units/meaning have been audited against the MCP source. */
export function normalizeResearchFacts(observations: Observation[]): { facts: ResearchFact[]; warnings: string[] } {
  const facts: ResearchFact[] = [];
  const warnings = new Set<string>();
  const decimal = (value: unknown): string | null => {
    const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
    return /^-?\d+(?:\.\d+)?$/.test(text) && text.length <= 60 ? text : null;
  };
  const pick = (...values: unknown[]): unknown => {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  };
  const asBool = (raw: unknown): boolean | null => {
    if (typeof raw === "boolean") return raw;
    if (raw === 1 || raw === "1" || raw === "true") return true;
    if (raw === 0 || raw === "0" || raw === "false") return false;
    return null;
  };
  for (const observation of observations) {
    const data = observation.data;
    if (observation.status !== "ok" || !data) {
      warnings.add(`${observation.capability.replaceAll("_", " ")}: data was unavailable. No value was assumed.`);
      logDropped(observation, "unavailable");
      continue;
    }
    const add = (path: string, label: string, raw: unknown, unit: string, venue: ResearchFact["venue"]) => {
      const value = decimal(raw);
      if (value === null) return;
      facts.push({ id: `${observation.id}:${path}`, label, value, unit, venue, evidenceId: observation.id, sourcePath: path, readAt: observation.observedAt });
    };
    const flag = (path: string, label: string, raw: unknown, yes: string, no: string) => {
      const bit = asBool(raw);
      if (bit === null) return;
      facts.push({
        id: `${observation.id}:${path}`, label, value: bit ? yes : no, unit: "",
        venue: "margin", evidenceId: observation.id, sourcePath: path, readAt: observation.observedAt,
      });
    };
    const rows = (key: string): Array<{ row: Record<string, unknown>; path: string }> => {
      if (!Array.isArray(data[key])) return [];
      return data[key].flatMap((row, index) => {
        if (!isRecord(row)) return [];
        if (row.error || row.available === false || row.status && !["ok", "not_funded"].includes(String(row.status))) {
          warnings.add(`${observation.capability.replaceAll("_", " ")}: some entries were unavailable.`);
          return [];
        }
        return [{ row, path: `${key}[${index}]` }];
      });
    };
    const listed = (...keys: string[]) => {
      for (const key of keys) {
        const found = rows(key);
        if (found.length) return found;
      }
      return [];
    };
    const assetLabel = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_/-]{1,24}$/.test(value) ? value : null;
    const before = facts.length;
    switch (observation.capability) {
      case "wallet_balances": {
        const walletRows = rows("assets").flatMap(({ row, path }) => {
          const symbol = assetLabel(row.symbol);
          return symbol ? [{ symbol, value: decimal(row.balance), path }] : [];
        });
        /**
         * The wallet read reports the same Stellar asset twice — once under its symbol and
         * once as `<SYMBOL>_SAC` (the Soroban contract wrapper for the identical holding).
         * Listing both showed "XLM 2781.947" and "XLM_SAC 2781.947" as separate balances,
         * which reads as twice the spendable capital. Keep the canonical symbol.
         */
        const canonical = new Map(walletRows.map((entry) => [entry.symbol, entry.value]));
        for (const entry of walletRows) {
          const base = entry.symbol.endsWith("_SAC") ? entry.symbol.slice(0, -4) : null;
          if (base && canonical.get(base) === entry.value) continue;
          add(`${entry.path}.balance`, `${entry.symbol} wallet balance`, entry.value, entry.symbol, "wallet");
        }
        add("fee_reserve_xlm", "Suggested fee reserve", data.fee_reserve_xlm, "XLM", "wallet");
        break;
      }
      case "account_health":
        add("health_factor", "Current health factor", data.health_factor, "HF", "margin");
        add("collateral_usd", "Reported collateral value", pick(data.collateral_usd, data.total_collateral_usd), "USD", "margin");
        add("debt_usd", "Reported debt value", pick(data.debt_usd, data.total_debt_usd), "USD", "margin");
        add("ltv_ratio", "Loan-to-value ratio", data.ltv_ratio, "ratio", "margin");
        flag("is_healthy", "Account health status", data.is_healthy, "healthy", "at risk");
        add("distance_to_liquidation", "Distance to liquidation", data.distance_to_liquidation, "ratio", "margin");
        add("net_available_collateral_usd", "Net available collateral", data.net_available_collateral_usd, "USD", "margin");
        add("net_borrow_rate_pct", "Net borrow rate", data.net_borrow_rate_pct, "% APR", "margin");
        add("borrow_threshold", "Borrow LTV threshold", data.borrow_threshold, "ratio", "margin");
        add("liquidation_threshold", "Liquidation LTV threshold", data.liquidation_threshold, "ratio", "margin");
        // Do not derive the app's HF from these fields: contract/UI semantics differ.
        break;
      case "account_position":
        add("health_factor", "Current health factor", data.health_factor, "HF", "margin");
        add("collateral_usd", "Reported collateral value", data.collateral_usd, "USD", "margin");
        add("debt_usd", "Reported debt value", data.debt_usd, "USD", "margin");
        break;
      case "can_withdraw":
      case "can_borrow": {
        const allowed = asBool(data.allowed)
          ?? (observation.capability === "can_withdraw" ? asBool(data.can_withdraw) : null)
          ?? (observation.capability === "can_borrow" ? asBool(data.can_borrow) : null);
        const amount = (typeof observation.args.amount === "string" ? observation.args.amount : null)
          ?? decimal(observation.args.amount)
          ?? (typeof data.amount === "string" ? data.amount : decimal(data.amount))
          ?? decimal(pick(data.max_withdraw_human, data.max_borrow_human));
        const asset = assetLabel(observation.args.asset) ?? assetLabel(data.symbol) ?? "asset";
        const verb = observation.capability === "can_withdraw" ? "withdraw" : "borrow";
        if (allowed !== null) {
          facts.push({
            id: `${observation.id}:allowed`,
            label: amount ? `${verb} ${amount} ${asset}` : `${verb} ${asset}`,
            value: allowed ? "allowed" : "not allowed",
            unit: "",
            venue: "margin",
            evidenceId: observation.id,
            sourcePath: "allowed",
            readAt: observation.observedAt,
          });
        }
        break;
      }
      case "account_debt":
        add("total_debt_usd", "Total margin debt", pick(data.total_debt_usd, data.debt_usd), "USD", "margin");
        for (const { row, path } of listed("debt", "borrows", "positions")) {
          const symbol = assetLabel(row.symbol);
          if (!symbol) continue;
          add(`${path}.balance`, `${symbol} borrowed`, pick(row.balance, row.amount_human, row.amount), symbol, "margin");
          add(`${path}.value_usd`, `${symbol} debt value`, pick(row.value_usd, row.usd), "USD", "margin");
        }
        break;
      case "account_collateral":
        add("total_value_usd", "Posted collateral value", pick(data.total_value_usd, data.total_collateral_usd, data.collateral_usd), "USD", "margin");
        for (const { row, path } of listed("collateral", "positions", "balances")) {
          const symbol = assetLabel(row.symbol);
          if (!symbol) continue;
          const usd = pick(row.value_usd, row.usd);
          if (decimal(usd) !== null) add(`${path}.value_usd`, `${symbol} collateral value`, usd, "USD", "margin");
          else add(`${path}.balance`, `${symbol} collateral`, pick(row.balance, row.amount_human, row.amount), symbol, "margin");
        }
        break;
      case "asset_price":
        add("price_usd", `${String(observation.args.asset)} oracle price`, data.price_usd, "USD", "oracle");
        break;
      case "earn_market": {
        const asset = String(observation.args.asset);
        // MCP's supply_apy_pct is documented as a simple APR alias, not compounded APY.
        add(data.supply_apr_pct == null ? "supply_apy_pct" : "supply_apr_pct", `${asset} Earn supply APR`, data.supply_apr_pct ?? data.supply_apy_pct, "% APR", "earn");
        add("borrow_apr_pct", `${asset} Earn borrow APR`, data.borrow_apr_pct, "% APR", "earn");
        add("total_liquidity_human", `${asset} Earn available liquidity`, data.total_liquidity_human, asset, "earn");
        break;
      }
      case "blend_markets":
        for (const { row, path } of rows("reserves")) {
          const symbol = assetLabel(row.symbol);
          if (!symbol) continue;
          add(`${path}.supply_apy_pct`, `${symbol} Blend supply APY`, row.supply_apy_pct, "% APY", "blend");
          add(`${path}.supply_apr_pct`, `${symbol} Blend supply APR`, row.supply_apr_pct, "% APR", "blend");
          add(`${path}.borrow_apy_pct`, `${symbol} Blend borrow APY`, row.borrow_apy_pct, "% APY", "blend");
        }
        if (Array.isArray(data.errors) && data.errors.length) warnings.add("Some Blend reserves could not be read; this is not a complete market comparison.");
        break;
      case "aquarius_markets": {
        /**
         * Surface each pool's PAIR and depth. The pair is a protocol fact the model was
         * previously left to guess at — and it guessed by asking the user "deposit the
         * AQUSDC alone, or add XLM alongside it?", which is not a user choice: an AMM add
         * is always both sides at the live ratio, exactly as the Farm form does it.
         *
         * The estimated API APY is still withheld: it is not an evaluated net return, and
         * this read carries no reserves, so the paired amount is derived at execution
         * rather than computed here.
         */
        for (const { row, path } of rows("pools")) {
          const pair = Array.isArray(row.tokens)
            ? row.tokens.filter((token): token is string => typeof token === "string").join(" + ")
            : null;
          if (!pair) continue;
          add(`${path}.liquidity_usd`, `Aquarius ${pair} pool depth`, row.liquidity_usd, "USD", "aquarius");
        }
        warnings.add("Aquarius pools were discovered; executable quotes and net returns have not been evaluated.");
        break;
      }
      /**
       * `enabled: true` is a configuration flag, not a working session.
       *
       * The Sign Service reports live failures alongside it — `session_expired`,
       * `session_not_active`, `no_active_session`, `over_daily_cap`, `unauthorized`
       * (see `mcp-write.ts`) — so reading only `enabled` labels a dead delegation
       * "Active". That is the one claim here that could talk someone into approving a
       * plan believing the server can carry it out unattended. When the status
       * contradicts the flag, the status wins and the authority is NOT called active.
       */
      case "signing_status": {
        if (typeof data.enabled !== "boolean") break;
        const reported = typeof data.status === "string" ? data.status.trim().toLowerCase() : "";
        const usable = !reported || /^(active|enabled|on|ok|ready)$/.test(reported);
        const value = !data.enabled ? "Off" : usable ? "Active" : `Not usable (${reported.replaceAll("_", " ")})`;
        facts.push({
          id: `${observation.id}:enabled`, label: "Server delegated signing", value, unit: "",
          venue: "signing", evidenceId: observation.id, sourcePath: "enabled", readAt: observation.observedAt,
        });
        if (data.enabled && !usable) warnings.add(
          "Server delegated signing is configured but not currently usable, so every transaction needs your wallet signature.");
        break;
      }
    }
    if (facts.length === before && observation.capability !== "aquarius_markets") {
      warnings.add(`${observation.capability.replaceAll("_", " ")}: no supported display fields were available.`);
      logDropped(observation, "no_fields");
    }
  }
  return { facts, warnings: [...warnings] };
}

/** Keys only — payloads are large and may still carry secrets the sanitizer missed. */
function logDropped(observation: Observation, kind: "unavailable" | "no_fields") {
  const data = observation.data;
  console.warn("[copilot] investigation fact extract", {
    capability: observation.capability,
    status: observation.status,
    kind,
    error: observation.error,
    keys: data && isRecord(data) ? Object.keys(data) : [],
  });
}
