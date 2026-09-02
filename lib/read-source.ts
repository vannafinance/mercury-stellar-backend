import { getAddress } from "@/lib/wallet-adapter";

// Source account for read-only `simulateTransaction` calls. The source only
// supplies fee/sequence context for a simulation — it NEVER affects a view
// call's result — so any funded account works. We use the connected wallet on
// the client (so a user's own sim is attributed to them), and a public funded
// account on the server or before wallet-connect. This lets the same read
// methods run in API routes (no Freighter) without changing any read result.
//
// Mirrors FALLBACK_SOURCE in oracle-price.ts / READ_SOURCE_ADDRESS in
// allMarginAccounts.ts (a funded public testnet account).
// Public testnet G-address used only as a fee/sequence source for simulations.
// Callers MUST tolerate it being unfunded (use Account(addr, "0") on getAccount miss).
// Do not Horizon-load this as if it were the user's account.
const READ_SOURCE_FALLBACK = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

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
