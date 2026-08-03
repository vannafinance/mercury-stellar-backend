import { getAddress } from "@/lib/wallet-adapter";

// Source account for read-only `simulateTransaction` calls. The source only
// supplies fee/sequence context for a simulation — it NEVER affects a view
// call's result — so any funded account works. We use the connected wallet on
// the client (so a user's own sim is attributed to them), and a public funded
// mainnet account on the server or before wallet-connect.
//
// Mirrors FALLBACK_SOURCE in oracle-price.ts / READ_SOURCE_ADDRESS in
// allMarginAccounts.ts (`vanna_mainnet_deployer` G-address — funded on pubnet).
const READ_SOURCE_FALLBACK = "GDT7ZBFWPYUY44QOA5TH3TGUYNPP6R5CF7EVXNYIW4U2ZQBUZ5NM3WYP";

export async function getReadSourceAddress(): Promise<string> {
  // Server (no browser) → never touch Freighter; use the public source.
  if (typeof window === "undefined") return READ_SOURCE_FALLBACK;
  try {
    const r = await getAddress();
    return r && !r.error && r.address ? r.address : READ_SOURCE_FALLBACK;
  } catch {
    return READ_SOURCE_FALLBACK;
  }
}
