import { getAddress } from "@stellar/freighter-api";

// Source account for read-only `simulateTransaction` calls. The source only
// supplies fee/sequence context for a simulation — it NEVER affects a view
// call's result — so any funded account works. We use the connected wallet on
// the client (so a user's own sim is attributed to them), and a public funded
// account on the server or before wallet-connect. This lets the same read
// methods run in API routes (no Freighter) without changing any read result.
//
// Mirrors FALLBACK_SOURCE in oracle-price.ts / READ_SOURCE_ADDRESS in
// allMarginAccounts.ts (a funded public testnet account).
const READ_SOURCE_FALLBACK = "GAUVY7FNDKVWRMW3SYEMX6QMFSWQDKC6XIPJJKAMOEMLZPAI7XZPDV3D";

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
