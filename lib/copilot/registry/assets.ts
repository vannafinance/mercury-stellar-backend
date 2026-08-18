/**
 * What an asset is — one answer, for every module that asks.
 *
 * ## The problem this replaces
 *
 * Asset knowledge was spread across six tables (`ASSETS`, `WRITE_ASSETS`,
 * `PRICE_SYMBOLS`, `BLEND_RESERVES`, `EARN_POOLS`, `EARN_POOL_SYMBOLS`) and four
 * mapping functions, each written for one caller. Nothing kept them in agreement with
 * each other, and nothing kept any of them in agreement with the chain.
 *
 * That is not a tidiness complaint. Every bug in the class looks the same from outside
 * — the copilot asks about a token the user never named, or acts on the wrong one —
 * and it is never one wrong line. It is two modules that disagree about what "USDC"
 * means, neither obviously wrong when read alone.
 *
 * ## Three facts that make this domain awkward, all of them real
 *
 *   1. "USDC" is not an asset. BLUSDC, AQUSDC and SOUSDC are three separate SACs, and
 *      a user who says only "USDC" has not chosen yet. Bare USDC is a QUESTION, which
 *      is why it is deliberately absent from every alias list below.
 *   2. One token can spell itself differently per venue. Blend USDC is `BLUSDC` to a
 *      user, `USDC` to the margin contract (which REJECTS the string "BLUSDC"), and
 *      `USDC` to the earn pool. Three names, one token.
 *   3. Three tokens, one price. All the dollar stables read off a single oracle feed,
 *      so pricing identity and token identity are different things and must not be
 *      collapsed — that is what makes a cross-stable leverage conversion correct.
 *
 * ## Everything venue-related here is checked against the chain
 *
 * `marginSymbol`, `earnSymbol` and `blendReserve` are verified by
 * tests/lib/asset-registry.test.ts against `chain-facts.json`, a recording of live MCP
 * reads. Only the ALIASES are hand-authored, because language is the one thing the
 * chain cannot tell us. A registry nobody checks is just the old hardcoded pair list
 * with better formatting.
 */

/** Every asset the copilot can name. Bare "USDC" is deliberately not one. */
export const ASSET_IDS = ["XLM", "BLUSDC", "AQUSDC", "SOUSDC", "AQUA", "EURC", "USDT"] as const;

export type AssetId = (typeof ASSET_IDS)[number];

/** The three tokens a bare "USDC" could mean. */
export const USDC_VARIANTS = ["BLUSDC", "AQUSDC", "SOUSDC"] as const satisfies readonly AssetId[];

export interface AssetDef {
  id: AssetId;
  /**
   * How a person might write it. Hand-authored — this is language, not protocol.
   * MUST NOT contain bare "USDC": that string is the ambiguity, not a name.
   */
  aliases: string[];
  /** The oracle feed that prices it. Three stables share one. */
  oracleSymbol: "XLM" | "USDC" | "AQUA" | "EURC";
  /** Symbol the margin contract wants, or null when it is not valid collateral. */
  marginSymbol: string | null;
  /** Symbol the earn pool wants, or null when it has no pool. */
  earnSymbol: string | null;
  /** Whether the registered Blend pool holds a reserve for it. */
  blendReserve: boolean;
  /** What the user is shown. Keeps BLUSDC visible even though the wire says USDC. */
  displayLabel: string;
}

const DEFS: Record<AssetId, AssetDef> = {
  XLM: {
    id: "XLM",
    // "BXLM" is Blend's own bToken symbol for a supplied XLM position — not a separate
    // spendable asset, but a real in-domain concept a rate/stats question can be about.
    aliases: ["XLM", "LUMEN", "LUMENS", "STELLAR", "XLM_SAC", "BXLM"],
    oracleSymbol: "XLM",
    marginSymbol: "XLM",
    earnSymbol: "XLM",
    blendReserve: true,
    displayLabel: "XLM",
  },
  BLUSDC: {
    id: "BLUSDC",
    // No bare "USDC" here — see the file header. "Blend USDC" is safe because it
    // names the variant.
    // "BUSDC" is Blend's own bToken symbol for the USDC reserve, same reasoning as BXLM.
    aliases: ["BLUSDC", "BLEND_USDC", "BLENDUSDC", "BLEND USDC", "BUSDC"],
    oracleSymbol: "USDC",
    // The contract REJECTS the string "BLUSDC" (chain-facts: allowed=false) and
    // accepts "USDC" for the same token. Verified, not assumed.
    marginSymbol: "USDC",
    earnSymbol: "USDC",
    blendReserve: true,
    displayLabel: "BLUSDC",
  },
  AQUSDC: {
    id: "AQUSDC",
    aliases: ["AQUSDC", "AQUARIUS_USDC", "AQUARIUSUSDC", "AQUARIUS USDC", "AQUIRESUSDC"],
    oracleSymbol: "USDC",
    marginSymbol: "AQUSDC",
    earnSymbol: "AQUSDC",
    blendReserve: false,
    displayLabel: "AQUSDC",
  },
  SOUSDC: {
    id: "SOUSDC",
    aliases: ["SOUSDC", "SOROSWAP_USDC", "SOROSWAPUSDC", "SOROSWAP USDC"],
    oracleSymbol: "USDC",
    marginSymbol: "SOUSDC",
    earnSymbol: "SOUSDC",
    blendReserve: false,
    displayLabel: "SOUSDC",
  },
  AQUA: {
    id: "AQUA",
    aliases: ["AQUA"],
    oracleSymbol: "AQUA",
    marginSymbol: null,
    earnSymbol: null,
    blendReserve: false,
    displayLabel: "AQUA",
  },
  EURC: {
    id: "EURC",
    aliases: ["EURC"],
    oracleSymbol: "EURC",
    // Nameable and priceable, but NOT valid collateral and no earn pool — both
    // confirmed against the chain. A single flat asset list cannot express this,
    // which is why five of them disagreed.
    marginSymbol: null,
    earnSymbol: null,
    blendReserve: false,
    displayLabel: "EURC",
  },
  /**
   * The one asset this registry's own header warned about and then still missed:
   * `AQUARIUS_POOLS`/`vertex-tools.ts` farm an XLM/USDT pair (`handle.ts`'s own comment:
   * "Vanna farms XLM/USDC and XLM/USDT only"), but USDT was never added here — so
   * `router.ts`'s dual-amount parser, `vertex-tools.ts`'s pair symbol list, and
   * `concept.ts`'s live-data override each hardcoded it independently instead of reading
   * it from here, the exact "six tables" disease this file exists to cure. Nameable and
   * priceable like EURC; not valid margin collateral or an Earn pool — an LP-pairing
   * token only.
   */
  USDT: {
    id: "USDT",
    aliases: ["USDT"],
    oracleSymbol: "USDC",
    marginSymbol: null,
    earnSymbol: null,
    blendReserve: false,
    displayLabel: "USDT",
  },
};

/**
 * Two ordered lists whose ORDER is load-bearing, so they stay written out rather than
 * derived — but their MEMBERSHIP is guarded by a test against `ASSET_IDS`, which is
 * what stops them drifting the way six separate tables did.
 *
 * Both contain bare "USDC" on purpose. The scanner has to be able to SEE the ambiguous
 * form in order to ask about it, and the model has to be able to say "the user did not
 * pick a variant" rather than guess one.
 */

/** Free-text scan order — longest first, so the USDC inside BLUSDC never matches alone. */
export const ASSET_SCAN_ORDER = [
  "BLUSDC",
  "AQUSDC",
  "SOUSDC",
  "USDC",
  "XLM",
  "AQUA",
  "EURC",
  "USDT",
] as const;

/** Enum offered to the model for a write. Order shapes the prompt, so it is fixed. */
export const WRITE_ASSET_ENUM = [
  "XLM",
  "BLUSDC",
  "AQUSDC",
  "SOUSDC",
  "USDC",
  "AQUA",
  "EURC",
  "USDT",
] as const;

export function assetDef(id: AssetId): AssetDef {
  return DEFS[id];
}

/** All defs, in declaration order. */
export function allAssets(): AssetDef[] {
  return ASSET_IDS.map((id) => DEFS[id]);
}

/**
 * Single-token asset words, lowercased, for modules that recognise "is this message
 * about a known asset at all" rather than resolving to one specific `AssetDef`.
 *
 * Built from `allAssets()`'s own aliases rather than hand-copied, because hand-copied is
 * exactly how the same bug happened four times in one week: "bXLM" was added to this
 * registry's XLM aliases, and had to be separately, manually added to the domain
 * firewall's vocabulary AND the page-guide classifier's asset pattern before either one
 * actually recognised it — three lists that were each individually plausible and each
 * quietly wrong. A multi-word alias ("BLEND USDC") is skipped: firewall/classifier word
 * lists match single `\b`-bounded tokens, and the single-word spellings ("BLUSDC",
 * "BLEND_USDC") already cover the same ground.
 */
export const ASSET_DOMAIN_WORDS: readonly string[] = allAssets()
  .flatMap((d) => d.aliases)
  .filter((a) => !/[\s]/.test(a))
  .map((a) => a.toLowerCase());

/**
 * One regex matching any known asset alias as a whole word — the same underlying list as
 * `ASSET_DOMAIN_WORDS`, shaped for a single `.test()`/`.exec()` call. See that export's
 * doc comment for why this must be derived, not hand-maintained.
 */
export const ASSET_SYMBOL_PATTERN = new RegExp(
  `\\b(?:${[...ASSET_DOMAIN_WORDS].sort((a, b) => b.length - a.length).join("|")})\\b`,
  "i",
);

// ── resolution ──────────────────────────────────────────────────────────────

export type AssetMatch =
  | { kind: "asset"; def: AssetDef }
  /** The user said "USDC". They have not chosen a token yet — ask. */
  | { kind: "ambiguous"; options: AssetDef[] }
  | { kind: "unknown" };

/** Longest alias first, so the USDC inside BLUSDC never matches on its own. */
const ALIAS_INDEX: Array<{ alias: string; def: AssetDef }> = allAssets()
  .flatMap((def) => def.aliases.map((alias) => ({ alias: alias.toUpperCase(), def })))
  .sort((a, b) => b.alias.length - a.alias.length);

const BARE_USDC = /(^|[^A-Z0-9])USDC([^A-Z0-9]|$)/;

/**
 * What asset — if any — this text names.
 *
 * The single entry point. `needsUsdcVariant`, `marginCollateralSymbol`,
 * `earnPoolSymbol` and the router's asset scan were four different answers to this
 * question; this is the one they now share.
 */
export function resolveAsset(text?: string | null): AssetMatch {
  const upper = String(text ?? "").toUpperCase();
  if (!upper.trim()) return { kind: "unknown" };

  for (const { alias, def } of ALIAS_INDEX) {
    const re = new RegExp(`(^|[^A-Z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z0-9]|$)`);
    if (re.test(upper)) return { kind: "asset", def };
  }

  // Only after every concrete variant has failed to match: an unqualified USDC is a
  // question, not an asset.
  if (BARE_USDC.test(upper)) {
    return { kind: "ambiguous", options: USDC_VARIANTS.map((v) => DEFS[v]) };
  }
  return { kind: "unknown" };
}

/** The def when the text names exactly one asset, else null. */
export function resolveAssetDef(text?: string | null): AssetDef | null {
  const m = resolveAsset(text);
  return m.kind === "asset" ? m.def : null;
}

/** True when the text is an unqualified "USDC" and a variant must be chosen. */
export function isAmbiguousUsdc(text?: string | null): boolean {
  return resolveAsset(text).kind === "ambiguous";
}

// ── venue views ─────────────────────────────────────────────────────────────

/** Contract symbols the margin protocol accepts as collateral. */
export function marginCollateralSymbols(): string[] {
  return [...new Set(allAssets().map((d) => d.marginSymbol).filter((s): s is string => !!s))];
}

/** Symbols the earn pools answer to. */
export function earnPoolSymbols(): string[] {
  return [...new Set(allAssets().map((d) => d.earnSymbol).filter((s): s is string => !!s))];
}

/** Symbols the registered Blend pool holds reserves for. */
export function blendReserveSymbols(): string[] {
  return [...new Set(allAssets().filter((d) => d.blendReserve).map((d) => d.marginSymbol ?? d.id))];
}

/** Oracle feeds worth requesting — three stables collapse to one. */
export function oracleSymbols(): string[] {
  return [...new Set(allAssets().map((d) => d.oracleSymbol))];
}

/** One unit is a dollar, so it needs no oracle round-trip. */
export function isDollarStable(asset?: string | null): boolean {
  const def = resolveAssetDef(asset);
  if (def) return def.oracleSymbol === "USDC";
  // Bare "USDC" is still a dollar even before the variant is chosen.
  return isAmbiguousUsdc(asset);
}
