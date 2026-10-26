import { isRecord } from "./decision";
import { extractFactsByShape } from "./facts-by-shape";
import { PAGE_BASIS_SOURCE } from "./health-basis";
import type { Observation } from "./types";
import type { ResearchFact } from "./view";

/**
 * Turn observations into display facts.
 *
 * Two passes per observation. First, a small set of branches for capabilities where a
 * real JUDGEMENT is needed that the response shape cannot express - each says why in
 * its comment and declares which top-level keys it consumed. Second, the shape-driven
 * extractor (`facts-by-shape.ts`) reads every remaining unit-bearing field from the
 * MCP's own naming conventions. A capability with no branch here is the normal case,
 * not a gap: it renders from its shape.
 *
 * Until 13 Sep this was a 14-case switch, and the 12 capabilities without a case -
 * `max_borrow`, `farm_overview`, `collateral_config`, `earn_position`, … - were read,
 * discarded, and reported to the user as "no supported display fields".
 */
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
    const noun = observation.capability.replaceAll("_", " ");
    if (observation.status !== "ok" || !data) {
      warnings.add(`${noun}: data was unavailable. No value was assumed.`);
      logDropped(observation, "unavailable");
      continue;
    }
    /**
     * `quantity` says this number is an amount of the row's own token, and it is declared
     * here because only the caller knows. It defaults to false so a figure is never
     * mistaken for a balance by accident - but a real token amount left unmarked would be
     * dropped from any row rendering, so the balance/spendable callers below set it.
     */
    const add = (path: string, label: string, raw: unknown, unit: string, venue: ResearchFact["venue"], quantity = false) => {
      const value = decimal(raw);
      if (value === null) return;
      facts.push({ id: `${observation.id}:${path}`, label, value, unit, venue, evidenceId: observation.id, sourcePath: path, readAt: observation.observedAt, quantity });
    };
    const flag = (path: string, label: string, raw: unknown, yes: string, no: string) => {
      const bit = asBool(raw);
      if (bit === null) return;
      facts.push({
        id: `${observation.id}:${path}`, label, value: bit ? yes : no, unit: "",
        venue: "margin", evidenceId: observation.id, sourcePath: path, readAt: observation.observedAt,
      });
    };
    /**
     * Rows a branch iterates. A row is unavailable only when it says so (`error`, or
     * `available: false`); a non-ok `status` is information the MCP attached on purpose
     * (`USDC: not_resolvable` - there is no plain USDC on this network) and is skipped
     * without a warning. Until 13 Sep that line alone produced "wallet balances: some
     * entries were unavailable" on every signed-in run.
     */
    const rows = (key: string): Array<{ row: Record<string, unknown>; path: string }> => {
      if (!Array.isArray(data[key])) return [];
      return data[key].flatMap((row, index) => {
        if (!isRecord(row)) return [];
        if (row.error || row.available === false) {
          const who = typeof row.symbol === "string" ? row.symbol : `${key}[${index}]`;
          const why = typeof row.message === "string" ? row.message : typeof row.error === "string" ? row.error : null;
          warnings.add(`${noun}: ${who} was unavailable${why ? ` - ${why}` : "."}`);
          return [];
        }
        if (typeof row.status === "string" && row.status !== "ok") return [];
        return [{ row, path: `${key}[${index}]` }];
      });
    };
    const assetLabel = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_/-]{1,24}$/.test(value) ? value : null;
    const consumed = new Set<string>();
    const before = facts.length;

    switch (observation.capability) {
      case "account_identity": {
        consumed.add("has_active_account");
        flag("has_active_account", "Margin account status", data.has_active_account, "active", "no active account found");
        break;
      }
      /**
       * Judgement: the wallet read reports the same Stellar asset twice - under its
       * symbol and as `<SYMBOL>_SAC` (the Soroban wrapper for the identical holding).
       * Shape alone would list "XLM 2781.947" and "XLM_SAC 2781.947" as two balances,
       * which reads as twice the spendable capital. Keep the canonical line only.
       */
      case "wallet_balances": {
        consumed.add("assets");
        const walletRows = rows("assets").flatMap(({ row, path }) => {
          const symbol = assetLabel(row.symbol);
          return symbol ? [{ symbol, value: decimal(row.balance), spendable: decimal(row.spendable), path }] : [];
        });
        const canonical = new Map(walletRows.map((entry) => [entry.symbol, entry.value]));
        for (const entry of walletRows) {
          const base = entry.symbol.endsWith("_SAC") ? entry.symbol.slice(0, -4) : null;
          if (base && canonical.get(base) === entry.value) continue;
          add(`${entry.path}.balance`, `${entry.symbol} wallet balance`, entry.value, entry.symbol, "wallet", true);
          if (entry.spendable !== null && entry.spendable !== entry.value) {
            add(`${entry.path}.spendable`, `${entry.symbol} wallet spendable`, entry.spendable, entry.symbol, "wallet", true);
          }
        }
        break;
      }
      /**
       * Judgement: `is_healthy` is worded as a state ("healthy" / "at risk"), and a
       * `page_debt_mismatch` flag means the app panel disagrees with the contract - the
       * panel figure is then reported as a disagreement, never as the health factor.
       * The health factor itself is never derived from collateral/debt here.
       */
      case "account_health":
      case "account_position":
      case "liquidation_snapshot": {
        consumed.add("is_healthy").add("liquidatable").add("unpriceable_plain").add("page_debt_mismatch").add("page_health_factor");
        const debt = decimal(data.debt_usd);
        if (debt !== null && Number(debt) === 0) {
          // Zero debt is a verified state, not a missing numeric ratio or an infinite JSON number.
          consumed.add("health_factor").add("posted_health_factor");
          facts.push({ id: `${observation.id}:health_factor_state`, label: "Debt status",
            value: "no outstanding debt", unit: "", venue: "margin", evidenceId: observation.id,
            sourcePath: "health_factor_state", readAt: observation.observedAt });
        }
        flag("is_healthy", "Account health status", data.is_healthy, "healthy", "at risk");
        flag(
          "unpriceable_plain",
          "Unpriceable plain collateral",
          data.unpriceable_plain,
          "AccountManager will refuse liquidation",
          "plain collateral is priced",
        );
        if (data.unpriceable_plain === undefined) {
          flag("liquidatable", "Liquidation snapshot flag", data.liquidatable, "liquidatable", "not liquidatable");
        }
        if (data.page_debt_mismatch === true) {
          facts.push({
            id: `${observation.id}:page_debt_mismatch`,
            label: "Account panel disagrees",
            value: typeof data.page_health_factor === "string" ? data.page_health_factor : "yes",
            unit: "",
            venue: "margin",
            evidenceId: observation.id,
            sourcePath: "page_debt_mismatch",
            readAt: observation.observedAt,
          });
        }
        /**
         * Judgement: ONE health basis reaches the reply. The risk engine counts collateral POSTED
         * to the contract; the Margin page counts everything the account HOLDS, and the page's is
         * what the user is told (owner, 29 Sep). A posted-basis collateral figure labelled only
         * "collateral" beside the debt, or a ratio the MCP computed from it, invites a second health
         * factor (24 Oct, live: "70.25 (most recently observed 82.28)"). So a risk-engine read gives
         * up those figures whenever the page's are present, and when it is the only basis it offers
         * its ratio as what it is - the posted-collateral figure - which the reply cannot quote as the
         * health factor. Which basis a read is on is what the read says about itself (`source`),
         * never the wording of the question.
         */
        const onPageBasis = (other: typeof observation) =>
          other.status === "ok" && isRecord(other.data) && other.data.source === PAGE_BASIS_SOURCE;
        if (onPageBasis(observation)) {
          consumed.add("net_leverage");
          add("net_leverage", "Net leverage taken", data.net_leverage, "x", "margin");
        } else {
          const pageElsewhere = observations.some((other) => other !== observation && onPageBasis(other));
          // The provenance block is metadata, not a measurement, and the MCP's own ratio is only ever
          // offered below as the posted-basis figure.
          consumed.add("source").add("health_factor");
          if (pageElsewhere) {
            // Everything the risk engine derives from posted collateral goes with it: the page states none of
            // these, and a "distance to liquidation" ratio beside the page's liquidation answer reads as a
            // second, unexplained one. Its plain verdict (`is_healthy`) is not a figure and stays.
            consumed.add("collateral_usd").add("collateral_usd_wad").add("ltv_ratio")
              .add("distance_to_liquidation").add("borrow_threshold").add("liquidation_threshold");
          } else {
            if (observation.capability === "account_health") {
              // `liquidation_snapshot` already names itself by its source; `account_health` is the read
              // whose "collateral" is indistinguishable from the page's, so it says what it is.
              consumed.add("collateral_usd");
              add("collateral_usd", "Collateral posted to the risk engine", data.collateral_usd, "USD", "margin");
            }
            // The ratio is kept as the posted-basis figure so the reply says it could not read the
            // page's, instead of quoting this one as the health factor.
            add("posted_health_factor", "Health factor on collateral posted to the risk engine", data.health_factor, "HF", "margin");
          }
        }
        break;
      }
      /**
       * Judgement: a liquidation price is a statement about each asset the account is exposed to, and
       * "no price liquidates it" is an answer, not a missing value. Both are said in words the reply can
       * cite ("none", with the health factor the account would still have near zero), never left as an
       * absent number the model fills in. The figures are the Margin page's own (liquidation.ts).
       */
      case "account_liquidation": {
        consumed.add("source").add("state").add("has_debt").add("exposures").add("all_together").add("pegged");
        // `health_factor_if_falls` sits inside each exposure, so it is read with it, not as a top-level key.
        // These facts only make sense together (a price, and what it assumes), so they declare their group here.
        const grouped = () => { for (const fact of facts.slice(before)) fact.group = "Liquidation"; };
        const text = (path: string, label: string, value: string) => facts.push({
          id: `${observation.id}:${path}`, label, value, unit: "", venue: "margin", evidenceId: observation.id,
          sourcePath: path, readAt: observation.observedAt,
        });
        if (data.state === "nodebt") {
          text("liquidation.status", "Liquidation status", "no debt, so no price liquidates the account");
          grouped();
          break;
        }
        if (data.state === "now") {
          text("liquidation.status", "Liquidation status", "the account is at or below the liquidation health factor now");
          grouped();
          break;
        }
        const exposures = Array.isArray(data.exposures) ? data.exposures.filter(isRecord) : [];
        exposures.forEach((exposure) => {
          const symbol = typeof exposure.symbol === "string" ? exposure.symbol : null;
          if (!symbol) return;
          const at = `liquidation.${symbol}`;
          const falling = isRecord(exposure.falling) ? exposure.falling : null;
          const rising = isRecord(exposure.rising) ? exposure.rising : null;
          if (falling) {
            add(`${at}.falling_price`, `${symbol} liquidation price`, falling.price_usd, "USD", "margin");
            const drop = decimal(falling.change_pct);
            if (drop !== null) add(`${at}.falling_drop`, `${symbol} drop to liquidation`, String(Math.abs(Number(drop))), "%", "margin");
          } else {
            text(`${at}.falling_price`, `${symbol} liquidation price`, "none");
            add(`${at}.health_factor_if_near_zero`, `Health factor if ${symbol} fell to near zero`, exposure.health_factor_if_near_zero, "HF", "margin");
          }
          (Array.isArray(exposure.health_factor_if_falls) ? exposure.health_factor_if_falls.filter(isRecord) : []).forEach((step) => {
            const pct = decimal(step.fall_pct);
            if (pct !== null) add(`${at}.health_factor_if_falls.${pct}`, `Health factor if ${symbol} fell ${pct}%`, step.health_factor, "HF", "margin");
          });
          if (rising) {
            add(`${at}.rising_liquidation_price`, `${symbol} price that liquidates the account on a rise`, rising.price_usd, "USD", "margin");
          }
        });
        (Array.isArray(data.pegged) ? data.pegged.filter(isRecord) : []).forEach((entry) => {
          if (typeof entry.symbol === "string") {
            text(`liquidation.${entry.symbol}.pegged`, `${entry.symbol} liquidation price`,
              "none, a dollar-pegged token the Margin page holds at $1 and moves no price for");
          }
        });
        if (exposures.length && isRecord(data.all_together)) {
          const drop = decimal(data.all_together.falling_pct);
          if (drop !== null) add("liquidation.all_together", "Fall in every volatile price at once that liquidates the account", String(Math.abs(Number(drop))), "%", "margin");
          else text("liquidation.all_together", "Fall in every volatile price at once that liquidates the account", "none");
        }
        grouped();
        break;
      }
      /**
       * Judgement: the fact is the verdict on the amount the user asked about, so the
       * label is composed from the request args ("withdraw 100 XLM"), not from the
       * response. `max_*_human` in the same payload is a plain number and comes from shape.
       */
      case "can_withdraw":
      case "can_borrow": {
        consumed.add("allowed").add("can_withdraw").add("can_borrow").add("amount");
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
      /**
       * Judgement: the MCP documents Earn's `supply_apy_pct` as a simple-APR alias, not a
       * compounded APY, so it must not be shown as "% APY" and is only used when the APR
       * field is absent. Everything else in the payload comes from shape.
       */
      case "earn_market": {
        consumed.add("supply_apy_pct");
        if (data.supply_apr_pct == null) {
          add("supply_apy_pct", `${String(observation.args.asset)} Earn supply APR`, data.supply_apy_pct, "% APR", "earn");
        }
        break;
      }
      /**
       * Judgement: an AMM pool is named by its PAIR, and the pair is a protocol fact the
       * model once guessed at ("deposit AQUSDC alone, or add XLM alongside?"). The
       * estimated API APY is withheld: it is not an evaluated net return.
       */
      case "aquarius_markets": {
        consumed.add("pools");
        for (const { row, path } of rows("pools")) {
          const pair = Array.isArray(row.tokens)
            ? row.tokens.filter((token): token is string => typeof token === "string").join(" + ")
            : null;
          if (!pair) continue;
          add(`${path}.liquidity_usd`, `Aquarius ${pair} pool depth`, row.liquidity_usd, "USD", "aquarius");
        }
        break;
      }
      /**
       * Judgement: `enabled: true` is a configuration flag, not a working session.
       *
       * The Sign Service reports live failures alongside it - `session_expired`,
       * `session_not_active`, `no_active_session`, `over_daily_cap`, `unauthorized`
       * (see `mcp-write.ts`) - so reading only `enabled` labels a dead delegation
       * "Active". That is the one claim here that could talk someone into approving a
       * plan believing the server can carry it out unattended. When the status
       * contradicts the flag, the status wins and the authority is NOT called active.
       */
      case "signing_status": {
        consumed.add("enabled").add("status");
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

    const shaped = extractFactsByShape(observation, consumed);
    const taken = new Set(facts.slice(before).map((fact) => fact.sourcePath));
    /**
     * Judgement: an Earn pool's `total_liquidity` is what is LEFT to borrow (total_assets minus total_borrows: 42,690 beside
     * 120,470 supplied and 77,780 borrowed for XLM), not a total. Named "total liquidity" it read as a disagreement with the
     * Earn page's "Assets Supplied" (24 Oct). The other two are what the page calls them.
     */
    const EARN_POOL_NAMES: Record<string, string> = {
      total_liquidity: "available liquidity", total_assets: "supplied", total_borrows: "borrowed",
    };
    for (const fact of shaped.facts) {
      if (taken.has(fact.path)) continue;
      const poolWords = observation.capability === "earn_market" ? EARN_POOL_NAMES[fact.path.replace(/_human$/, "")] : undefined;
      const label = poolWords ? `${String(observation.args.asset)} Earn ${poolWords}` : fact.label;
      facts.push({ id: `${observation.id}:${fact.path}`, label, value: fact.value, unit: fact.unit, venue: fact.venue, evidenceId: observation.id, sourcePath: fact.path, readAt: observation.observedAt, quantity: fact.quantity });
    }
    for (const row of shaped.unavailable) {
      warnings.add(`${noun}: ${row.identity ?? row.path} was unavailable${row.message ? ` - ${row.message}` : "."}`);
    }
    if (Array.isArray(data.errors) && data.errors.length) {
      warnings.add(`${noun}: ${data.errors.length} ${data.errors.length === 1 ? "entry" : "entries"} could not be read; this is not a complete picture.`);
    }
    if (facts.length === before && observation.capability !== "aquarius_markets") {
      // A successful identity/list read need not contain display measurements.
      // Keep extraction diagnostics in logs; real read failures remain user warnings above.
      logDropped(observation, "no_fields");
    }
  }
  return { facts, warnings: [...warnings] };
}

/** Keys only - payloads are large and may still carry secrets the sanitizer missed. */
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
