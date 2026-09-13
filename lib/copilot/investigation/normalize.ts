import { isRecord } from "./decision";
import type { Observation } from "./types";
import type { ResearchFact } from "./view";

const PLUMBING = /^(duration_ms|error|message|unsigned_xdr|auth_entries|code|function|contract|note|lp_note|source|summary|warning|kind|available|status|smart_account|trader|account)$/i;

/**
 * Facts come from the payload's own keys, not from the capability name.
 *
 * MCP already names units in the suffix (`*_human`, `*_usd`, `*_pct`, `*_wad`,
 * `*_address`, `*_ratio`). A switch over capability names silently drops any
 * successful read whose name is not on that list — live, `max_borrow` returned
 * `max_borrow_human` and the card said the number was missing.
 *
 * Hand-written branches stay only where shape cannot express a judgement.
 */
export function normalizeResearchFacts(observations: Observation[]): { facts: ResearchFact[]; warnings: string[] } {
  const facts: ResearchFact[] = [];
  const warnings = new Set<string>();
  const decimal = (value: unknown): string | null => {
    const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
    return /^-?\d+(?:\.\d+)?$/.test(text) && text.length <= 60 ? text : null;
  };
  const asBool = (raw: unknown): boolean | null => {
    if (typeof raw === "boolean") return raw;
    if (raw === 1 || raw === "1" || raw === "true") return true;
    if (raw === 0 || raw === "0" || raw === "false") return false;
    return null;
  };
  const assetLabel = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_/-]{1,24}$/.test(value) ? value : null;
  const venueOf = (capability: string): ResearchFact["venue"] => {
    if (capability.includes("wallet")) return "wallet";
    if (capability.includes("blend")) return "blend";
    if (capability.includes("earn")) return "earn";
    if (capability.includes("aquarius")) return "aquarius";
    if (capability.includes("price") || capability.includes("oracle")) return "oracle";
    if (capability.includes("sign")) return "signing";
    return "margin";
  };

  for (const observation of observations) {
    const data = observation.data;
    if (observation.status !== "ok" || !data) {
      warnings.add(`${observation.capability.replaceAll("_", " ")}: data was unavailable. No value was assumed.`);
      logDropped(observation, "unavailable");
      continue;
    }
    const venue = venueOf(observation.capability);
    const before = facts.length;
    const add = (path: string, label: string, raw: unknown, unit: string, factVenue = venue) => {
      const value = decimal(raw);
      if (value === null) return;
      facts.push({
        id: `${observation.id}:${path}`, label, value, unit, venue: factVenue,
        evidenceId: observation.id, sourcePath: path, readAt: observation.observedAt,
      });
    };

    /**
     * Shape cannot say whether `enabled: true` plus `status: session_expired` is
     * a working session. Calling that "Active" would talk someone into approving
     * a plan the server cannot carry out unattended.
     */
    if (observation.capability === "signing_status") {
      if (typeof data.enabled === "boolean") {
        const reported = typeof data.status === "string" ? data.status.trim().toLowerCase() : "";
        const usable = !reported || /^(active|enabled|on|ok|ready)$/.test(reported);
        const value = !data.enabled ? "Off" : usable ? "Active" : `Not usable (${reported.replaceAll("_", " ")})`;
        facts.push({
          id: `${observation.id}:enabled`, label: "Server delegated signing", value, unit: "",
          venue: "signing", evidenceId: observation.id, sourcePath: "enabled", readAt: observation.observedAt,
        });
        if (data.enabled && !usable) warnings.add(
          "Server delegated signing is configured but not currently usable, so every transaction needs your wallet signature.");
      }
      if (facts.length === before) {
        warnings.add(`${observation.capability.replaceAll("_", " ")}: no supported display fields were available.`);
        logDropped(observation, "no_fields");
      }
      continue;
    }

    /**
     * Eligibility is args + payload: "allowed" alone is not "withdraw 100 XLM".
     * Shape cannot bind the model's requested size to the risk-engine answer.
     */
    if (observation.capability === "can_withdraw" || observation.capability === "can_borrow") {
      const allowed = asBool(data.allowed)
        ?? (observation.capability === "can_withdraw" ? asBool(data.can_withdraw) : null)
        ?? (observation.capability === "can_borrow" ? asBool(data.can_borrow) : null);
      const amount = (typeof observation.args.amount === "string" ? observation.args.amount : null)
        ?? decimal(observation.args.amount)
        ?? (typeof data.amount === "string" ? data.amount : decimal(data.amount))
        ?? decimal(data.max_withdraw_human)
        ?? decimal(data.max_borrow_human);
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
      if (facts.length === before) {
        warnings.add(`${observation.capability.replaceAll("_", " ")}: no supported display fields were available.`);
        logDropped(observation, "no_fields");
      }
      continue;
    }

    const emitLeaf = (path: string, key: string, raw: unknown, ctx: Record<string, unknown>, arrayKind: string | null) => {
      const symbol = assetLabel(ctx.symbol) ?? assetLabel(ctx.asset) ?? assetLabel(observation.args.asset);
      const bit = asBool(raw);
      if (bit !== null && (/^is_/.test(key) || key === "allowed" || key === "liquidatable" || key === "enabled")) {
        const yes = key === "liquidatable" ? "liquidatable" : key === "is_healthy" ? "healthy" : "yes";
        const no = key === "liquidatable" ? "not liquidatable" : key === "is_healthy" ? "at risk" : "no";
        facts.push({
          id: `${observation.id}:${path}`,
          label: key === "is_healthy" ? "Account health status"
            : key === "liquidatable" ? "Liquidation snapshot flag"
            : key.replaceAll("_", " "),
          value: bit ? yes : no,
          unit: "",
          venue,
          evidenceId: observation.id,
          sourcePath: path,
          readAt: observation.observedAt,
        });
        return;
      }
      const value = decimal(raw);
      if (value === null) return;
      if (key.endsWith("_wad") && Object.keys(ctx).some((k) => k === key.slice(0, -4) + "_human")) return;

      let unit = "";
      if (key.endsWith("_usd") || key === "usd") unit = "USD";
      else if (key.endsWith("_pct")) {
        // Earn documents supply_apy_pct as a simple APR alias, not compounded APY.
        if (observation.capability === "earn_market" && key === "supply_apy_pct") unit = "% APR";
        else if (/apr/i.test(key)) unit = "% APR";
        else if (/apy/i.test(key)) unit = "% APY";
        else unit = "%";
      } else if (key.endsWith("_ratio")) unit = "ratio";
      else if (key.endsWith("_address")) unit = "address";
      else if (key.endsWith("_wad")) unit = "WAD";
      else if (/_xlm$/i.test(key)) unit = "XLM";
      else if (key.endsWith("_human")) unit = symbol ?? "";
      else if (symbol && (key === "balance" || key === "amount" || key === "amount_human")) unit = symbol;
      else if (key === "health_factor" || key.endsWith("_health_factor")) unit = "HF";

      let label: string;
      if (arrayKind === "assets" && (key === "balance" || key === "amount_human") && symbol) {
        label = `${symbol} wallet balance`;
      } else if (arrayKind === "collateral" && symbol) {
        label = unit === "USD" ? `${symbol} collateral value` : `${symbol} collateral`;
      } else if ((arrayKind === "debt" || arrayKind === "borrows") && symbol) {
        label = unit === "USD" ? `${symbol} debt value` : `${symbol} borrowed`;
      } else if (arrayKind === "reserves" && symbol) {
        label = `${symbol} Blend ${key.replaceAll("_", " ").replace(/ pct$/, "")}`;
      } else if (arrayKind === "pools") {
        const pair = Array.isArray(ctx.tokens)
          ? ctx.tokens.filter((t): t is string => typeof t === "string").join(" + ")
          : null;
        label = pair ? `Aquarius ${pair} pool depth` : key.replaceAll("_", " ");
      } else if (key === "health_factor") label = "Current health factor";
      else if (key === "posted_health_factor") label = "Posted-collateral health factor";
      else if (key === "collateral_usd" && observation.capability === "liquidation_snapshot") label = "Contract liquidation collateral";
      else if (key === "debt_usd" && observation.capability === "liquidation_snapshot") label = "Contract liquidation debt";
      else if (key === "fee_reserve_xlm") label = "Suggested fee reserve";
      else {
        const stem = key.replace(/_human$|_usd$|_pct$|_wad$|_address$|_ratio$/, "").replaceAll("_", " ");
        const titled = stem.replace(/\b(apy|apr|usd|hf|ltv)\b/gi, (m) => m.toUpperCase());
        label = titled.charAt(0).toUpperCase() + titled.slice(1);
        if (observation.capability === "earn_market" && symbol) label = `${symbol} Earn ${titled}`;
        if (observation.capability === "blend_reserve" && symbol) label = `${symbol} Blend ${titled}`;
        if (observation.capability === "asset_price") label = `${String(observation.args.asset)} oracle price`;
      }
      add(path, label, raw, unit);
    };

    const walk = (node: unknown, path: string, ctx: Record<string, unknown>, arrayKind: string | null) => {
      if (Array.isArray(node)) {
        const kind = path.split(".").pop() ?? arrayKind;
        node.forEach((item, index) => {
          if (!isRecord(item)) return;
          if (item.error || item.available === false || (item.status && !["ok", "not_funded"].includes(String(item.status)))) {
            warnings.add(`${observation.capability.replaceAll("_", " ")}: some entries were unavailable.`);
            return;
          }
          walk(item, `${path}[${index}]`, item, kind);
        });
        return;
      }
      if (!isRecord(node)) {
        const key = path.split(".").pop()?.replace(/\[\d+\]/g, "") ?? path;
        if (!PLUMBING.test(key)) emitLeaf(path, key, node, ctx, arrayKind);
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (PLUMBING.test(key)) continue;
        const next = path ? `${path}.${key}` : key;
        if (isRecord(value) || Array.isArray(value)) walk(value, next, isRecord(value) ? value : node, arrayKind);
        else emitLeaf(next, key, value, node, arrayKind);
      }
    };

    walk(data, "", data, null);

    /**
     * Panel vs contract debt is a judgement: the boolean flag plus the page HF
     * must not be listed as two unrelated facts, and the panel number must not
     * be quoted as health. Shape cannot express that.
     */
    if (asBool(data.page_debt_mismatch) === true) {
      const panel = typeof data.page_health_factor === "string" || typeof data.page_health_factor === "number"
        ? String(data.page_health_factor) : "yes";
      for (let i = facts.length - 1; i >= 0; i--) {
        if (facts[i].evidenceId === observation.id
          && (facts[i].sourcePath === "page_debt_mismatch" || facts[i].sourcePath === "page_health_factor")) {
          facts.splice(i, 1);
        }
      }
      facts.push({
        id: `${observation.id}:page_debt_mismatch`,
        label: "Account panel disagrees",
        value: panel,
        unit: "",
        venue: "margin",
        evidenceId: observation.id,
        sourcePath: "page_debt_mismatch",
        readAt: observation.observedAt,
      });
    }

    /**
     * The wallet read reports the same Stellar asset twice — symbol and `<SYMBOL>_SAC`.
     * Shape cannot know they are one holding. Keep the canonical symbol.
     */
    if (observation.capability === "wallet_balances") {
      const walletFacts = facts.filter((f) => f.evidenceId === observation.id && f.venue === "wallet");
      const bySymbol = new Map<string, string>();
      for (const fact of walletFacts) {
        const match = fact.label.match(/^([A-Za-z0-9]+) wallet balance$/);
        if (match) bySymbol.set(match[1], fact.value);
      }
      for (let i = facts.length - 1; i >= 0; i--) {
        const fact = facts[i];
        if (fact.evidenceId !== observation.id || fact.venue !== "wallet") continue;
        const match = fact.label.match(/^([A-Za-z0-9]+)_SAC wallet balance$/);
        if (match && bySymbol.get(match[1]) === fact.value) facts.splice(i, 1);
      }
    }

    if (observation.capability === "aquarius_markets") {
      warnings.add("Aquarius pools were discovered; executable quotes and net returns have not been evaluated.");
    }
    if (Array.isArray(data.errors) && data.errors.length) {
      warnings.add("Some Blend reserves could not be read; this is not a complete market comparison.");
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
