/**
 * Facts derived from the SHAPE of an MCP response, not from the capability's name.
 *
 * The normalizer used to be a switch over capability names. Twelve of the twenty-six
 * capabilities the loop can read had no branch, so a successful `max_borrow` or
 * `farm_overview` read was discarded and the user told the data was unavailable
 * (first signed-in battery, 11 Sep). The MCP already says what its fields mean in the
 * key names and units — `*_pct`, `*_usd`, `*_human`, `*_wad`, `*_address` — so the
 * extractor reads those conventions instead. A capability nobody has written a branch
 * for renders the same day the MCP ships it.
 *
 * What is deliberately NOT a fact: anything without a unit the key can vouch for (a
 * bare number is not a balance until the key says which token), raw/WAD integers,
 * addresses and ids, notes and summaries, and any field the row itself marks
 * `<field>_untrusted`. Never invent a unit.
 */

import { ASSET_IDS, assetDef, assetForVenueSpelling, lpVenues, type AssetDef } from "../registry/assets";
import { isRecord } from "./decision";
import type { Observation } from "./types";
import type { ResearchFact } from "./view";

/**
 * The asset a read was made for, when its `args.asset` is a registry id. A venue spells
 * that asset its own way (`pool_symbol: "USDC"` for BLUSDC, AQUSDC and SOUSDC alike), and
 * a fact labelled by the venue's spelling cannot be told apart on the card — 13 Sep: three
 * "USDC Earn" rates with no way to say which pool was which. The registry records each
 * asset's venue spellings (`earnSymbol`, `marginSymbol`), so a row symbol that equals one
 * of them names the requested asset, not the wire word.
 */
function requestedAsset(observation: Observation): AssetDef | null {
  const asset = observation.args.asset;
  return typeof asset === "string" && (ASSET_IDS as readonly string[]).includes(asset) ? assetDef(asset as AssetDef["id"]) : null;
}

/**
 * Translate a read's rows into registry ids ONCE, where the observation is born, so the
 * model, the facts, the sealed evidence and the sizer all see the same `asset` beside the
 * venue's `symbol`. The model reads observations raw (`JSON.stringify(turn)`), so a label
 * fixed only in the facts never reaches it — 13 Sep: shown `{ symbol: "USDC" }` on a debt
 * row, it named AQUSDC, then SOUSDC, for a BLUSDC debt. Rows that already carry `asset`
 * are left alone; a symbol no venue spelling resolves stays as it is.
 */
export function annotateVenueAssets(observation: Pick<Observation, "capability" | "args"> & { data: Record<string, unknown> }): Record<string, unknown>;
export function annotateVenueAssets(observation: Pick<Observation, "capability" | "args" | "data">): Observation["data"];
export function annotateVenueAssets(observation: Pick<Observation, "capability" | "args" | "data">): Observation["data"] {
  const data = observation.data;
  if (!data) return data;
  const requested = requestedAsset(observation as Observation);
  const walk = (node: unknown, segments: string[], depth: number): unknown => {
    if (depth > MAX_DEPTH) return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, segments, depth + 1));
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = walk(value, [...segments, key], depth + 1);
    if (typeof node.symbol === "string" && isSymbol(node.symbol) && typeof node.asset !== "string") {
      const venue = venueFrom(observation.capability, segments, node);
      const asset = canonical(node.symbol, requested, venue);
      if (asset !== node.symbol || (ASSET_IDS as readonly string[]).includes(asset)) out.asset = asset;
    }
    return out;
  };
  return walk(data, [], 0) as Observation["data"];
}

function canonical(symbol: string, requested: AssetDef | null, venue: Venue | null = null): string {
  const upper = symbol.toUpperCase();
  if (requested && [requested.id, requested.earnSymbol, requested.marginSymbol, requested.oracleSymbol]
    .some((spelling) => spelling && spelling.toUpperCase() === upper)) return requested.id;
  // No requested asset (a debt or collateral listing): the venue's own spelling decides, when unique.
  if (venue === "margin" || venue === "earn") return assetForVenueSpelling(venue, symbol)?.id ?? symbol;
  return symbol;
}

type Venue = ResearchFact["venue"];

export interface ShapeFact {
  path: string;
  label: string;
  value: string;
  unit: string;
  venue: Venue;
  /**
   * True only when this number is an AMOUNT OF THE ROW'S TOKEN — a balance, a receipt
   * balance, an underlying value. False for everything else `unitFor` produces: a rate,
   * a ratio, a health factor, a percentage, a bare integer.
   *
   * Decided here, where the unit itself is decided, because a consumer cannot tell the
   * two apart afterwards: "rate" and "XLM" are both non-empty unit strings, and the
   * symbol test that builds token units matches "rate" and "HF" just as happily. On
   * 20 Sep a Blend answer printed `b_rate` as the user's XLM balance for exactly that
   * reason — the renderer took the row's first non-USD number and called it a quantity.
   */
  quantity: boolean;
}

export interface ShapeExtraction {
  facts: ShapeFact[];
  /** Rows the response itself marked failed: `error` set or `available: false`. */
  unavailable: Array<{ path: string; identity: string | null; message: string | null }>;
}

const MAX_DEPTH = 5;
const MAX_FACTS = 40;

/** Metadata and prose the MCP attaches to every payload. Never a number to show. */
const SKIP_KEYS = new Set([
  "duration_ms", "note", "summary", "message", "reason", "warning", "hint", "method",
  "source", "scope", "api_base", "status", "venue", "kind", "resolved", "requested", "fetched",
  "decimals", "count", "position_count", "smart_account", "holder", "wallet", "errors",
]);
const SKIP_SUFFIXES = ["_note", "_hint", "_address", "address", "_contract", "contract", "_id", "_raw", "_wad", "_count", "_token", "_symbol", "_untrusted"];

/**
 * Suffix conventions carry the unit. Stem conventions carry it for a handful of
 * well-known fields whose unit is the row's own token or a dimensionless ratio.
 */
function unitFor(key: string, identity: string | null, row: Record<string, unknown>, requested: AssetDef | null = null, venue: Venue | null = null): { unit: string; field: string; quantity?: true } | null {
  if (key.endsWith("_pct")) {
    const stem = key.slice(0, -4);
    const unit = /(^|_)apy$/.test(stem) ? "% APY" : /(^|_)apr$/.test(stem) ? "% APR" : "%";
    return { unit, field: stem };
  }
  if (key.endsWith("_usd")) return { unit: "USD", field: key.slice(0, -4) };
  if (key.endsWith("_xlm")) return { unit: "XLM", field: key.slice(0, -4), quantity: true };
  // A vToken payload's bare `human` is the receipt-token amount; every `<x>_human`
  // beside it (`redeemable_human`) is in the underlying.
  if (key === "human") return { unit: tokenOf(row, identity, true, requested, venue), field: "balance", quantity: true };
  if (key.endsWith("_human")) return { unit: tokenOf(row, identity, false, requested, venue), field: key.slice(0, -6), quantity: true };
  if (key === "health_factor" || key.endsWith("_health_factor")) return { unit: "HF", field: key };
  if (key === "ratio" || key.endsWith("_ratio") || key.endsWith("_threshold") || key === "distance_to_liquidation") return { unit: "ratio", field: key };
  if (key === "rate" || key.endsWith("_rate")) return { unit: "rate", field: key };
  if (/^(max|min)_/.test(key) && Number.isInteger(Number(row[key]))) return { unit: "", field: key };
  if (["balance", "spendable", "min_balance", "underlying_value", "total_supply", "total_borrow", "total_borrows", "total_liquidity", "total_assets", "lp_shares", "shares"].includes(key)) {
    const unit = tokenOf(row, identity, false, requested, venue);
    return unit ? { unit, field: key, quantity: true } : null;
  }
  return null;
}

/** The token a row is about: its own symbol fields first, then the identity the path gave it. */
function tokenOf(row: Record<string, unknown>, identity: string | null, receipt = false, requested: AssetDef | null = null, venue: Venue | null = null): string {
  for (const key of [...(receipt ? ["vtoken_symbol"] : []), "symbol", "asset", "pool_symbol", "token", "tracking_symbol"]) {
    const value = row[key];
    if (typeof value === "string" && isSymbol(value)) return canonical(value, requested, venue);
  }
  return identity ?? "";
}

function isSymbol(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_/-]{0,23}$/.test(value);
}

function identityOf(row: Record<string, unknown>, fallback: string | null, requested: AssetDef | null = null, venue: Venue | null = null): string | null {
  for (const key of ["symbol", "asset", "pool_symbol", "token"]) {
    const value = row[key];
    if (typeof value === "string" && isSymbol(value)) return canonical(value, requested, venue);
  }
  if (typeof row.token_a === "string" && typeof row.token_b === "string") return `${row.token_a}/${row.token_b}`;
  if (Array.isArray(row.tokens)) {
    const pair = row.tokens.filter((t): t is string => typeof t === "string" && isSymbol(t));
    if (pair.length) return pair.join("/");
  }
  return fallback;
}

const VENUE_WORDS: Record<string, Venue> = { blend: "blend", earn: "earn", aquarius: "aquarius", oracle: "oracle", wallet: "wallet", signing: "signing", vtoken: "earn", lp: "aquarius", prices: "oracle", price: "oracle" };

function venueFrom(capability: string, segments: readonly string[], row: Record<string, unknown>): Venue {
  const explicit = typeof row.venue === "string" ? VENUE_WORDS[row.venue.toLowerCase()] : undefined;
  if (explicit) return explicit;
  for (const segment of segments) {
    const hit = VENUE_WORDS[segment.toLowerCase()];
    if (hit) return hit;
  }
  for (const word of capability.split("_")) {
    const hit = VENUE_WORDS[word];
    if (hit) return hit;
  }
  if (capability === "asset_price" || capability === "prices_batch") return "oracle";
  if (capability === "earn_position" || capability === "earn_market" || capability.startsWith("vtoken")) return "earn";
  return "margin";
}

const WORD_CASE: Record<string, string> = { apr: "APR", apy: "APY", usd: "USD", hf: "HF", ltv: "LTV", lp: "LP", xlm: "XLM", b: "b" };

function words(key: string): string {
  return key.split("_").filter(Boolean).map((w) => WORD_CASE[w] ?? w).join(" ");
}

const VENUE_LABEL: Partial<Record<Venue, string>> = { earn: "Earn", blend: "Blend", aquarius: "Aquarius", wallet: "wallet", oracle: "oracle" };

/**
 * `<identity> <venue> <field>`: "XLM Earn supply APR", "XLM wallet balance",
 * "XLM/USDC Aquarius LP shares", "Total debt". The parent collection name is kept
 * when it says what the number is a part of ("XLM collateral value").
 */
function labelFor(capability: string, identity: string | null, venue: Venue, parents: readonly string[], field: string, venueName?: string): string {
  const parent = parents.length ? parents[parents.length - 1] : null;
  const venueWord = venueName ?? VENUE_LABEL[venue];
  /**
   * The parent collection's name is kept only for the words that add meaning: venue
   * words are already in the label, a symbol-keyed record (`prices.XLM`) is the identity,
   * and generic container names say nothing.
   */
  const parentWord = parent && parent !== identity && !(isSymbol(parent) && /^[A-Z]/.test(parent))
    && !["positions", "reserves", "assets", "pools", "rows", "items"].includes(parent)
    ? parent.split("_").filter((w) => w && !VENUE_WORDS[w.toLowerCase()]).map((w) => WORD_CASE[w] ?? w).join(" ") || null
    : null;
  const fieldWords = parentWord && parentWord.split(" ").includes(words(field)) ? "" : words(field);
  /**
   * An account-level number with no asset and no venue is named by the read that
   * produced it: "Liquidation snapshot collateral" and "Account health collateral" are
   * different sources of a similar number, and the reader must be able to tell.
   */
  const sourceWord = !identity && !venueWord && !parentWord && venue === "margin" && !fieldWords.startsWith(words(capability))
    ? words(capability) : null;
  const text = [identity, venueWord, parentWord, sourceWord, fieldWords].filter(Boolean).join(" ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function decimalOf(value: unknown): string | null {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  return /^-?\d+(?:\.\d+)?$/.test(text) && text.length <= 60 ? text : null;
}

/** "0.30%" style strings carry their own unit. */
function percentString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(value.trim());
  return m ? m[1] : null;
}

function rowUnavailable(row: Record<string, unknown>): boolean {
  return Boolean(row.error) || row.available === false;
}

/**
 * A row that reports a non-ok status is information, not failure — the wallet read
 * lists `USDC: not_resolvable` on purpose ("never silently omitted"). Its numbers are
 * not shown, and it is not a warning.
 */
function rowInformational(row: Record<string, unknown>): boolean {
  return typeof row.status === "string" && row.status !== "ok";
}

export function extractFactsByShape(observation: Observation, consumed: ReadonlySet<string> = new Set()): ShapeExtraction {
  const facts: ShapeFact[] = [];
  const unavailable: ShapeExtraction["unavailable"] = [];
  const seenValues = new Set<string>();
  const data = observation.data;
  if (!data) return { facts, unavailable };
  const rootIdentity = typeof observation.args.asset === "string" && isSymbol(observation.args.asset) ? observation.args.asset : null;
  const requested = requestedAsset(observation);

  const walk = (node: Record<string, unknown>, path: string, segments: string[], identity: string | null, depth: number) => {
    if (depth > MAX_DEPTH || facts.length >= MAX_FACTS) return;
    if (rowUnavailable(node)) {
      unavailable.push({ path, identity: identityOf(node, identity, requested), message: typeof node.message === "string" ? node.message : typeof node.error === "string" ? node.error : null });
      return;
    }
    const informational = rowInformational(node);
    const venue = venueFrom(observation.capability, segments, node);
    const here = identityOf(node, identity, requested, venue);
    // A row naming a registry LP venue ("soroswap") is labelled by it; the fact's venue type has
    // no Soroswap, and "XLM/SOUSDC Aquarius LP shares" named the wrong DEX (25 Sep, live).
    const lpName = typeof node.venue === "string" && (lpVenues() as readonly string[]).includes(node.venue.toLowerCase())
      ? node.venue.charAt(0).toUpperCase() + node.venue.slice(1).toLowerCase() : undefined;
    for (const [key, raw] of Object.entries(node)) {
      if (facts.length >= MAX_FACTS) return;
      if (depth === 0 && consumed.has(key)) continue;
      if (SKIP_KEYS.has(key) || SKIP_SUFFIXES.some((s) => key.endsWith(s))) continue;
      if (node[`${key}_untrusted`] === true) continue;
      const childPath = path ? `${path}.${key}` : key;
      if (Array.isArray(raw)) {
        raw.forEach((item, index) => {
          if (isRecord(item)) walk(item, `${childPath}[${index}]`, [...segments, key], here, depth + 1);
        });
        continue;
      }
      if (isRecord(raw)) {
        // A record keyed by symbol (`prices: { XLM: {...} }`) names its rows by key.
        walk(raw, childPath, [...segments, key], isSymbol(key) && /^[A-Z]/.test(key) ? key : here, depth + 1);
        continue;
      }
      if (informational) continue;
      if (typeof raw === "boolean") {
        if (key.startsWith("has_") || key === "allowed" && depth === 0) continue;
        // A yes/no is never an amount of anything.
        facts.push({ path: childPath, label: labelFor(observation.capability, here, venue, segments, key.replace(/^is_/, ""), lpName), value: raw ? "yes" : "no", unit: "", venue, quantity: false });
        continue;
      }
      const pct = percentString(raw);
      if (pct !== null) {
        const unit = /apy/.test(key) ? "% APY" : /apr/.test(key) ? "% APR" : "%";
        push(childPath, labelFor(observation.capability, here, venue, segments, key, lpName), pct, unit, venue);
        continue;
      }
      const meta = unitFor(key, here, node, requested, venue);
      if (!meta) continue;
      const value = decimalOf(raw);
      if (value === null) continue;
      push(childPath, labelFor(observation.capability, here, venue, segments, meta.field, lpName), value, meta.unit, venue, meta.quantity === true);
    }
  };

  const push = (path: string, label: string, value: string, unit: string, venue: Venue, quantity = false) => {
    // The same number under two aliases (`debt_usd` / `total_debt_usd`) is one fact.
    const key = `${value}|${unit}|${label}`;
    if (seenValues.has(key)) return;
    seenValues.add(key);
    facts.push({ path, label, value, unit, venue, quantity });
  };

  walk(data, "", [], rootIdentity, 0);
  return { facts, unavailable };
}
