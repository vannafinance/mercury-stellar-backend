/**
 * Farm pool catalogue for the V3 Farm screens: which pool a `/farm/:id` route is, the display
 * labels of its tokens, and the small shared helpers (USD price lookup, explorer link, timestamp
 * normalisation). Everything comes from the existing Stellar configs — Blend's two reserves
 * (XLM / USDC), `AQUARIUS_POOLS` and `SOROSWAP_POOLS` — so a pool added there shows up here.
 *
 * Route ids (unchanged from the previous Farm page, also used by Portfolio and Copilot links):
 * `xlm` / `usdc` → Blend supply; `soroswap-*` → Soroswap LP; an `AQUARIUS_POOLS` id (or its
 * tokens joined by "-", e.g. `xlm-usdc`) → Aquarius LP.
 */
import { AQUARIUS_POOLS, type AquariusPoolConfig } from "@/lib/aquarius-utils";
import { SOROSWAP_POOLS, type SoroswapPoolConfig } from "@/lib/soroswap-utils";

export type BlendToken = "XLM" | "USDC";
export const BLEND_TOKENS: readonly BlendToken[] = ["XLM", "USDC"] as const;

export type FarmPoolRef =
  | { kind: "blend"; id: string; venue: "Blend"; token: BlendToken; label: string }
  | { kind: "aquarius"; id: string; venue: "Aquarius"; tokens: [string, string]; labels: [string, string]; cfg: AquariusPoolConfig }
  | { kind: "soroswap"; id: string; venue: "Soroswap"; tokens: [string, string]; labels: [string, string]; cfg: SoroswapPoolConfig };

/**
 * Pools permanently excluded from the LP list — this Aquarius testnet pair has stale/unrelated
 * data and isn't a real, usable pool. (Its route still opens, as before.)
 */
export const HIDDEN_POOL_IDS = new Set<string>(["aquarius-xlm-usdt"]);

/** Hide stroop-level rounding residue left after a 100% withdrawal ("0.00 LP / $0.00" ghost rows). */
export const POSITION_DUST = 1e-4;

/**
 * Display label of a token inside a venue. "USDC" is a different SAC per venue (Blend's BLUSDC,
 * Aquarius's AqUSDC, Soroswap's SoUSDC). Display only — every balance read and every
 * transaction keeps using the raw symbol from the pool config.
 */
export function venueLabel(venue: "Blend" | "Aquarius" | "Soroswap", sym: string): string {
  if (sym !== "USDC") return sym;
  return venue === "Blend" ? "BLUSDC" : venue === "Aquarius" ? "AqUSDC" : "SoUSDC";
}

export const blendRef = (token: BlendToken): FarmPoolRef => ({ kind: "blend", id: token.toLowerCase(), venue: "Blend", token, label: venueLabel("Blend", token) });
export const aquariusRef = (cfg: AquariusPoolConfig): FarmPoolRef => ({
  kind: "aquarius",
  id: cfg.id,
  venue: "Aquarius",
  tokens: [cfg.tokens[0], cfg.tokens[1]],
  labels: [venueLabel("Aquarius", cfg.tokens[0]), venueLabel("Aquarius", cfg.tokens[1])],
  cfg,
});
export const soroswapRef = (cfg: SoroswapPoolConfig): FarmPoolRef => ({
  kind: "soroswap",
  id: cfg.id,
  venue: "Soroswap",
  tokens: [cfg.tokens[0], cfg.tokens[1]],
  labels: [venueLabel("Soroswap", cfg.tokens[0]), venueLabel("Soroswap", cfg.tokens[1])],
  cfg,
});

/** The pool a `/farm/:id` route is, or null for an id that matches no configured pool. */
export function resolveFarmPool(rawId: string | undefined | null): FarmPoolRef | null {
  const id = (rawId ?? "").toLowerCase();
  if (!id) return null;
  const upper = id.toUpperCase();
  if ((BLEND_TOKENS as readonly string[]).includes(upper)) return blendRef(upper as BlendToken);
  if (id.startsWith("soroswap-")) {
    const cfg = SOROSWAP_POOLS.find((p) => p.id === id);
    return cfg ? soroswapRef(cfg) : null;
  }
  const aq = AQUARIUS_POOLS.find((p) => p.id === id || p.tokens.join("-").toLowerCase() === id);
  return aq ? aquariusRef(aq) : null;
}

/** "XLM" / "XLM / AqUSDC". */
export const poolTitle = (p: FarmPoolRef) => (p.kind === "blend" ? p.token : `${p.labels[0]} / ${p.labels[1]}`);

/** USD price of a farm token from a `useTokenPrices(["XLM","USDC","USDT"])` map (USDC variants alias to USDC). */
export function priceFor(prices: Record<string, number>, sym: string): number {
  const s = sym.toUpperCase();
  if (s === "XLM") return prices.XLM ?? 0;
  if (s === "USDC" || s === "BLUSDC" || s === "AQUSDC" || s === "SOUSDC") return prices.USDC ?? 1;
  if (s === "USDT") return prices.USDT ?? 1;
  return 0;
}

export const FARM_PRICE_SYMBOLS = ["XLM", "USDC", "USDT"];

/** stellar.expert link for a transaction hash (testnet, as everywhere else in the app). */
export const txUrl = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

/** Event timestamps arrive as unix seconds (Blend ledger close time) or ms — always return ms. */
export const normalizeTimestamp = (value: unknown): number => {
  const ts = Number(value ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts < 1_000_000_000_000 ? ts * 1000 : ts;
};

/** "Oct 7, 15:00" (local), "Never" for 0. */
export const timeLbl = (ms: number) =>
  ms ? new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "Never";
