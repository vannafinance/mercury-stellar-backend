/**
 * What an asset is - one answer, for every module that asks.
 *
 * ## The problem this replaces
 *
 * Asset knowledge was spread across six tables (`ASSETS`, `WRITE_ASSETS`,
 * `PRICE_SYMBOLS`, `BLEND_RESERVES`, `EARN_POOLS`, `EARN_POOL_SYMBOLS`) and four
 * mapping functions, each written for one caller. Nothing kept them in agreement with
 * each other, and nothing kept any of them in agreement with the chain.
 *
 * That is not a tidiness complaint. Every bug in the class looks the same from outside
 * - the copilot asks about a token the user never named, or acts on the wrong one -
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
 *      collapsed - that is what makes a cross-stable leverage conversion correct.
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

/** Where a token can go. The two LP venues each pair XLM with their own USDC. */
export const VENUES = ["margin", "earn", "blend", "aquarius", "soroswap"] as const;
export type Venue = (typeof VENUES)[number];
export type LpVenue = Extract<Venue, "aquarius" | "soroswap">;

export interface AssetDef {
  id: AssetId;
  /**
   * How a person might write it. Hand-authored - this is language, not protocol.
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
  /** The LP venue whose XLM pool pairs with this token, if any - checked against `chain-facts.json`. */
  lpVenue: LpVenue | null;
  /** What the user is shown. Keeps BLUSDC visible even though the wire says USDC. */
  displayLabel: string;
}

const DEFS: Record<AssetId, AssetDef> = {
  XLM: {
    id: "XLM",
    // "BXLM" is Blend's own bToken symbol for a supplied XLM position - not a separate
    // spendable asset, but a real in-domain concept a rate/stats question can be about.
    aliases: ["XLM", "LUMEN", "LUMENS", "STELLAR", "XLM_SAC", "BXLM"],
    oracleSymbol: "XLM",
    marginSymbol: "XLM",
    earnSymbol: "XLM",
    blendReserve: true,
    lpVenue: null,
    displayLabel: "XLM",
  },
  BLUSDC: {
    id: "BLUSDC",
    // No bare "USDC" here - see the file header. "Blend USDC" is safe because it
    // names the variant.
    // "BUSDC" is Blend's own bToken symbol for the USDC reserve, same reasoning as BXLM.
    aliases: ["BLUSDC", "BLEND_USDC", "BLENDUSDC", "BLEND USDC", "BUSDC"],
    oracleSymbol: "USDC",
    // The contract REJECTS the string "BLUSDC" (chain-facts: allowed=false) and
    // accepts "USDC" for the same token. Verified, not assumed.
    marginSymbol: "USDC",
    earnSymbol: "USDC",
    blendReserve: true,
    lpVenue: null,
    displayLabel: "BLUSDC",
  },
  AQUSDC: {
    id: "AQUSDC",
    aliases: ["AQUSDC", "AQUARIUS_USDC", "AQUARIUSUSDC", "AQUARIUS USDC"],
    oracleSymbol: "USDC",
    marginSymbol: "AQUSDC",
    earnSymbol: "AQUSDC",
    blendReserve: false,
    lpVenue: "aquarius",
    displayLabel: "AQUSDC",
  },
  SOUSDC: {
    id: "SOUSDC",
    aliases: ["SOUSDC", "SOROSWAP_USDC", "SOROSWAPUSDC", "SOROSWAP USDC"],
    oracleSymbol: "USDC",
    marginSymbol: "SOUSDC",
    earnSymbol: "SOUSDC",
    blendReserve: false,
    lpVenue: "soroswap",
    displayLabel: "SOUSDC",
  },
  AQUA: {
    id: "AQUA",
    aliases: ["AQUA"],
    oracleSymbol: "AQUA",
    marginSymbol: null,
    earnSymbol: null,
    blendReserve: false,
    lpVenue: null,
    displayLabel: "AQUA",
  },
  EURC: {
    id: "EURC",
    aliases: ["EURC"],
    oracleSymbol: "EURC",
    // Nameable and priceable, but NOT valid collateral and no earn pool - both
    // confirmed against the chain. A single flat asset list cannot express this,
    // which is why five of them disagreed.
    marginSymbol: null,
    earnSymbol: null,
    blendReserve: false,
    lpVenue: null,
    displayLabel: "EURC",
  },
  /**
   * The one asset this registry's own header warned about and then still missed:
   * `AQUARIUS_POOLS`/`vertex-tools.ts` farm an XLM/USDT pair (`handle.ts`'s own comment:
   * "Vanna farms XLM/USDC and XLM/USDT only"), but USDT was never added here - so
   * `router.ts`'s dual-amount parser, `vertex-tools.ts`'s pair symbol list, and
   * `concept.ts`'s live-data override each hardcoded it independently instead of reading
   * it from here, the exact "six tables" disease this file exists to cure. Nameable and
   * priceable like EURC; not valid margin collateral or an Earn pool - an LP-pairing
   * token only.
   */
  USDT: {
    id: "USDT",
    aliases: ["USDT"],
    oracleSymbol: "USDC",
    marginSymbol: null,
    earnSymbol: null,
    blendReserve: false,
    lpVenue: null,
    displayLabel: "USDT",
  },
};

/**
 * Two ordered lists whose ORDER is load-bearing, so they stay written out rather than
 * derived - but their MEMBERSHIP is guarded by a test against `ASSET_IDS`, which is
 * what stops them drifting the way six separate tables did.
 *
 * Both contain bare "USDC" on purpose. The scanner has to be able to SEE the ambiguous
 * form in order to ask about it, and the model has to be able to say "the user did not
 * pick a variant" rather than guess one.
 */

/** Free-text scan order - longest first, so the USDC inside BLUSDC never matches alone. */
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
 * actually recognised it - three lists that were each individually plausible and each
 * quietly wrong. A multi-word alias ("BLEND USDC") is skipped: firewall/classifier word
 * lists match single `\b`-bounded tokens, and the single-word spellings ("BLUSDC",
 * "BLEND_USDC") already cover the same ground.
 */
export const ASSET_DOMAIN_WORDS: readonly string[] = allAssets()
  .flatMap((d) => d.aliases)
  .filter((a) => !/[\s]/.test(a))
  .map((a) => a.toLowerCase());

/**
 * One regex matching any known asset alias as a whole word - the same underlying list as
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
  /** The user said "USDC". They have not chosen a token yet - ask. */
  | { kind: "ambiguous"; options: AssetDef[] }
  | { kind: "unknown" };

/** Longest alias first, so the USDC inside BLUSDC never matches on its own. */
const ALIAS_INDEX: Array<{ alias: string; def: AssetDef }> = allAssets()
  .flatMap((def) => def.aliases.map((alias) => ({ alias: alias.toUpperCase(), def })))
  .sort((a, b) => b.alias.length - a.alias.length);

const BARE_USDC = /(^|[^A-Z0-9])USDC([^A-Z0-9]|$)/;

/**
 * What asset - if any - this text names.
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

/**
 * Edit distance counting a swap of two neighbouring letters as one slip (optimal string alignment).
 * A person mistypes a ticker by an extra, a missing, a wrong or a swapped letter - each is one slip.
 */
function slips(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Each asset's canonical ticker (its first alias), when long enough to be told apart from an ordinary word. */
const TICKERS: ReadonlyArray<{ ticker: string; id: string }> = allAssets()
  .flatMap((def) => def.aliases.length ? [{ ticker: def.aliases[0].toUpperCase(), id: def.id }] : [])
  .filter(({ ticker }) => ticker.length >= 6 && !/[\s_]/.test(ticker));

/**
 * A ticker one slip away from exactly one asset, read as that asset.
 *
 * "soudsdc" is "SOUSDC" with an extra letter; sent as typed it named no asset, so the request was not read as a
 * stated action and ended as a plan with no button (24 Oct). Only a word of six letters or more is considered,
 * only against each asset's own ticker (never against words like STELLAR or LUMENS that are ordinary English),
 * and only when one asset is the clear nearest - a tie is left alone, for the question that follows. Every
 * correction is returned so the reply can say what it read; the user's own message is never rewritten on screen.
 */
export function correctAssetSpellings(text: string): { text: string; corrections: Array<{ from: string; to: string }> } {
  const corrections: Array<{ from: string; to: string }> = [];
  const known = new Set(ALIAS_INDEX.map(({ alias }) => alias));
  const out = text.replace(/[A-Za-z][A-Za-z0-9_]{5,}/g, (word) => {
    const upper = word.toUpperCase();
    if (known.has(upper)) return word;
    const near = TICKERS.filter(({ ticker }) => slips(upper, ticker) <= 1);
    if (near.length !== 1) return word;
    corrections.push({ from: word, to: near[0].ticker });
    return near[0].ticker;
  });
  return { text: out, corrections };
}

/** The def when the text names exactly one asset, else null. */
export function resolveAssetDef(text?: string | null): AssetDef | null {
  const m = resolveAsset(text);
  return m.kind === "asset" ? m.def : null;
}

/** An alias as a literal regex fragment. */
function aliasSource(alias: string): string {
  return alias.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
}

/** Whether the text names this asset by one of its own registry aliases. */
export function namesAsset(text: string | null | undefined, id: string): boolean {
  const upper = String(text ?? "").toUpperCase();
  return ALIAS_INDEX.some(({ alias, def }) => def.id === id &&
    new RegExp(`(^|[^A-Z0-9])${aliasSource(alias)}([^A-Z0-9]|$)`).test(upper));
}

/**
 * Whether the text says "USDC" somewhere WITHOUT naming which one, even beside other assets
 * ("swap 100 XLM to USDC"). `resolveAsset` stops at the first asset it finds, so it cannot
 * answer this for a sentence that also names XLM. Every variant alias is removed first, so
 * "Blend USDC" or "AQUSDC" never counts as bare.
 */
export function mentionsBareUsdc(text: string | null | undefined): boolean {
  let upper = String(text ?? "").toUpperCase();
  for (const { alias } of ALIAS_INDEX) {
    upper = upper.replace(new RegExp(`(^|[^A-Z0-9])${aliasSource(alias)}(?=[^A-Z0-9]|$)`, "g"), "$1 ");
  }
  return BARE_USDC.test(upper);
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

/** The LP pools the routers resolve: each LP venue pairs XLM with its own USDC. */
export function lpPairs(): Array<{ venue: LpVenue; tokens: [AssetId, AssetId] }> {
  return allAssets().filter((d) => d.lpVenue).map((d) => ({ venue: d.lpVenue!, tokens: ["XLM", d.id] }));
}

/**
 * The DEX venues the protocol routes through, from the assets that name one - never a
 * hand-kept list. A `vanna_swap` or an LP write takes one of these as its `venue`.
 */
export function lpVenues(): LpVenue[] {
  return [...new Set(allAssets().flatMap((d) => (d.lpVenue ? [d.lpVenue] : [])))].sort();
}

/**
 * The DEX pool that trades a pair, from the pairs the registry already declares - each LP
 * venue pairs XLM with its own USDC. Null when no pool holds both, which is the honest
 * answer for BLUSDC (Blend's USDC has no DEX pool) and for AQUSDC against SOUSDC (two
 * different venues, no shared pool).
 */
export function poolVenueFor(a: string, b: string): LpVenue | null {
  const pair = lpPairs().find(({ tokens }) =>
    (tokens[0] === a && tokens[1] === b) || (tokens[0] === b && tokens[1] === a));
  return pair?.venue ?? null;
}

/** What an asset can actually be swapped for, from the pools that exist. */
export function swappableWith(asset: string): AssetId[] {
  return lpPairs().flatMap(({ tokens }) =>
    tokens[0] === asset ? [tokens[1]] : tokens[1] === asset ? [tokens[0]] : []);
}

/**
 * The venue a swap routes through when neither asset names one (XLM for BLUSDC, say) and
 * the user did not either. This mirrors `vanna_swap`'s own default rather than choosing
 * for the protocol; it is stated once so no caller invents its own.
 */
export const DEFAULT_SWAP_VENUE: LpVenue = "soroswap";

/** Every venue this asset can sit in, from its own fields - nothing is listed twice. */
export function venuesOf(def: AssetDef): Venue[] {
  const venues: Venue[] = [];
  if (def.marginSymbol) venues.push("margin");
  if (def.earnSymbol) venues.push("earn");
  if (def.blendReserve) venues.push("blend");
  if (def.lpVenue) venues.push(def.lpVenue);
  if (def.id === "XLM") venues.push(...lpPairs().map((p) => p.venue));
  return [...new Set(venues)];
}

/**
 * Whether Vanna takes this asset anywhere: as collateral, in Earn, in Blend or in a pool. An asset no
 * venue takes can be named (so it can be recognised and refused) but not used, and the owner's ruling
 * (8 Oct) is that Vanna does not support it, whatever an oracle feed or a pool listing elsewhere says.
 * Derived from the venue fields, never listed by name, so a new asset gets the right answer by being added.
 */
export function isSupportedAsset(def: AssetDef): boolean {
  return venuesOf(def).length > 0;
}

/** The assets a text names by their own registry aliases. A bare "USDC" names none: it is a question. */
export function assetsNamedIn(text: string | null | undefined): AssetDef[] {
  return allAssets().filter((def) => namesAsset(text, def.id));
}

/** venue → the assets it takes. The prompt prints this instead of a hand-written list. */
export function venueTable(): Array<{ venue: Venue; assets: AssetId[] }> {
  return VENUES.map((venue) => ({ venue, assets: allAssets().filter((d) => venuesOf(d).includes(venue)).map((d) => d.id) }));
}

/**
 * The venues that settle "which USDC" by themselves: those that take exactly one variant.
 * Naming such a venue is naming the token - there is nothing left to ask.
 */
export function venueUsdc(): Array<{ venue: Venue; usdc: AssetId }> {
  return venueTable().flatMap(({ venue, assets }) => {
    const variants = assets.filter((a) => (USDC_VARIANTS as readonly AssetId[]).includes(a));
    return variants.length === 1 ? [{ venue, usdc: variants[0] }] : [];
  });
}

/**
 * The asset a venue means by a symbol: the margin account and the Earn pools spell BLUSDC
 * as "USDC" (`marginSymbol` / `earnSymbol`). A row from those venues carrying that word is
 * BLUSDC, and only BLUSDC - the mapping is unique or it is not used. 13 Sep: a debt row
 * `{ symbol: "USDC" }` was read as AQUSDC by the model, and a repay was sized against a
 * debt that did not exist.
 */
export function assetForVenueSpelling(venue: "margin" | "earn", symbol: string): AssetDef | null {
  const upper = symbol.toUpperCase();
  const field = venue === "margin" ? "marginSymbol" : "earnSymbol";
  const direct = allAssets().find((d) => d.id === upper);
  if (direct) return direct;
  const matches = allAssets().filter((d) => d[field]?.toUpperCase() === upper);
  return matches.length === 1 ? matches[0] : null;
}

/** The venue spellings that differ from the asset id, for the prompt: "BLUSDC is USDC to the margin account and Earn". */
export function venueSpellings(): Array<{ asset: AssetId; spelling: string; venues: Array<"margin" | "earn"> }> {
  const out: Array<{ asset: AssetId; spelling: string; venues: Array<"margin" | "earn"> }> = [];
  for (const def of allAssets()) {
    const bySpelling = new Map<string, Array<"margin" | "earn">>();
    if (def.marginSymbol && def.marginSymbol !== def.id) bySpelling.set(def.marginSymbol, [...(bySpelling.get(def.marginSymbol) ?? []), "margin"]);
    if (def.earnSymbol && def.earnSymbol !== def.id) bySpelling.set(def.earnSymbol, [...(bySpelling.get(def.earnSymbol) ?? []), "earn"]);
    for (const [spelling, venues] of bySpelling) out.push({ asset: def.id, spelling, venues });
  }
  return out;
}

/** Oracle feeds worth requesting - three stables collapse to one. */
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
