import { Asset, Networks } from "@stellar/stellar-sdk";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";

/** The plain margin assets whose balance a token contract reports. */
export const SEP41_ASSET_IDS: readonly string[] = Object.freeze(["XLM", "BLUSDC", "AQUSDC", "SOUSDC"]);

/**
 * The SEP-41 token contract behind a plain margin asset, or undefined for any other. A holder's real balance
 * of a token is read from it (`vanna_get_token_balance`): that is what a transfer out of the holder can spend.
 * Resolved on demand, not when the module loads, so importing the catalog never touches the Stellar SDK.
 */
export function sep41Token(asset: string): string | undefined {
  switch (asset) {
    case "XLM": return Asset.native().contractId(Networks.TESTNET);
    case "BLUSDC": return CONTRACT_ADDRESSES.BLEND_USDC_TOKEN;
    case "AQUSDC": return CONTRACT_ADDRESSES.AQUARIUS_USDC_TOKEN;
    case "SOUSDC": return CONTRACT_ADDRESSES.SOROSWAP_USDC_TOKEN;
    default: return undefined;
  }
}
