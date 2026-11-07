/**
 * The Stellar lending pools (credit-layer Reserves) the Earn V3 screens show, in one place: the internal pool key
 * (`AssetType`, as used by hooks/use-earn.ts, the earn store and ContractService), the display
 * symbol (same names the rest of the app uses — see STELLAR_POOLS in lib/constants/earn), the
 * oracle symbol it is priced with, and its on-chain contracts.
 *
 * AQUARIUS_USDC / SOROSWAP_USDC have no Reflector entry of their own; they piggyback on USDC's
 * oracle price (the alias resolves inside oracle-price.ts), exactly as the pre-V3 Earn page did.
 */
import { ASSET_TYPES, CONTRACT_ADDRESSES, type AssetType } from "@/lib/stellar-utils";
import { STELLAR_POOLS } from "@/lib/constants/earn";

/** Keys of the pools /api/pools and useUserPositions return. */
export type PoolKey = "XLM" | "USDC" | "AQUARIUS_USDC" | "SOROSWAP_USDC";

export interface EarnPoolDef {
  key: PoolKey;
  /** ContractService asset type (same string as `key`). */
  assetType: AssetType;
  /** Display symbol (XLM / BLUSDC / AqUSDC / SoUSDC). */
  sym: string;
  /** Oracle symbol for USD values. */
  priceSym: "XLM" | "USDC";
  decimals: number;
  lendingProtocol: string;
  vToken: string;
}

/** Every Earn pool, in the order the app has always listed them. */
export const EARN_POOLS: EarnPoolDef[] = (["XLM", "USDC", "AQUARIUS_USDC", "SOROSWAP_USDC"] as const).map((key) => ({
  key,
  assetType: ASSET_TYPES[key] as AssetType,
  sym: STELLAR_POOLS[key].symbol,
  priceSym: key === "XLM" ? "XLM" : "USDC",
  decimals: STELLAR_POOLS[key].decimals,
  lendingProtocol: STELLAR_POOLS[key].lendingProtocol,
  vToken: STELLAR_POOLS[key].vToken,
}));

/** Oracle symbols the Earn screens price with. */
export const EARN_PRICE_SYMS = ["XLM", "USDC"];

/** Every spelling a route / deep link may use for a pool (case-insensitive). */
const ALIASES: Record<PoolKey, string[]> = {
  XLM: ["xlm"],
  USDC: ["usdc", "blusdc", "blend_usdc"],
  AQUARIUS_USDC: ["aqusdc", "aquarius_usdc", "aquiresusdc"],
  SOROSWAP_USDC: ["sousdc", "soroswap_usdc", "soroswapusdc"],
};

/** Pool for a route id / symbol / key (case-insensitive), or undefined. */
export function findPool(id: string): EarnPoolDef | undefined {
  const k = id.trim().toLowerCase();
  return EARN_POOLS.find((p) => ALIASES[p.key].includes(k));
}

/** Stellar Expert (testnet) links. */
export const EXPLORER = "https://stellar.expert/explorer/testnet";
export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const explorerContract = (id: string) => `${EXPLORER}/contract/${id}`;
export const explorerAccount = (id: string) => `${EXPLORER}/account/${id}`;

/**
 * On-chain contracts listed on the Details tab. Credit layer: the Reserve is both the lending
 * contract and the v-share token (so it is listed once), its interest curve lives inside it, and
 * the CreditLayer (margin accounts, borrow, health checks) replaced the old Registry / Risk Engine.
 */
export function poolAddresses(p: EarnPoolDef): [string, string, string][] {
  return [
    [`${p.sym} Reserve (v${p.sym} share token)`, p.lendingProtocol, `Lending reserve for ${p.sym}; also the v${p.sym} share token and its interest-rate curve`],
    ["Credit Layer", CONTRACT_ADDRESSES.CREDIT_LAYER, "Margin accounts, borrowing, health checks and liquidation"],
    ["Oracle Contract", CONTRACT_ADDRESSES.ORACLE, "Price oracle for asset valuations"],
  ];
}
