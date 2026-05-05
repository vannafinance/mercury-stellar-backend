"use client";

import { useQuery } from "@tanstack/react-query";
import { useLedgerTick } from "@/contexts/ledger-subscriber";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  CONTRACT_ADDRESSES,
  SOROBAN_RPC_URL,
  NETWORK_PASSPHRASE,
} from "@/lib/stellar-utils";

const ORACLE_CONTRACT = CONTRACT_ADDRESSES.ORACLE;

// Base symbols fetched directly from the oracle contract.
const ORACLE_SYMBOLS = ["XLM", "USDC", "EURC"] as const;
type OracleSymbol = (typeof ORACLE_SYMBOLS)[number];

// Derivative tokens that resolve to a base oracle symbol.
// e.g. BLUSDC is Blend's USDC pool token — its price equals USDC on-chain.
const DERIVATIVE_TO_BASE: Record<string, OracleSymbol> = {
  BLUSDC: "USDC",
  AQUSDC: "USDC",
  SOUSDC: "USDC",
  AQUARIUS_USDC: "USDC",
  SOROSWAP_USDC: "USDC",
};

// Last-resort fallbacks — only used when oracle AND cache both fail.
const FALLBACK_PRICES: Record<string, number> = {
  XLM: 0.16,
  USDC: 1.0,
  EURC: 1.0,
};

const CACHE_KEY = "vanna:oraclePrices";

function readCachedPrices(): Record<string, number> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { prices: Record<string, number>; ts: number };
    if (!parsed.prices || typeof parsed.prices !== "object") return null;
    return parsed.prices;
  } catch {
    return null;
  }
}

function writeCachedPrices(prices: Record<string, number>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ prices, ts: Date.now() }));
  } catch { /* ignore quota / private mode errors */ }
}

function decodeOraclePriceResult(retval: StellarSdk.xdr.ScVal): number {
  const native = StellarSdk.scValToNative(retval);

  if (typeof native === "number") return native;
  if (typeof native === "bigint") return Number(native) / 1e18;

  if (Array.isArray(native) && native.length >= 2) {
    const [price, decimals] = native;
    return Number(price) / Math.pow(10, Number(decimals));
  }

  if (native && typeof native === "object") {
    const p = native.price ?? native.p ?? native[0];
    const d = native.decimals ?? native.d ?? native[1] ?? 18;
    if (p != null) return Number(p) / Math.pow(10, Number(d));
  }

  return Number(native) || 0;
}

async function fetchOraclePrices(): Promise<Record<string, number>> {
  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

  const dummyPubkey = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  let sourceAccount: StellarSdk.Account;
  try {
    sourceAccount = await server.getAccount(dummyPubkey);
  } catch {
    sourceAccount = new StellarSdk.Account(dummyPubkey, "0");
  }

  // Step 1: Fetch base prices from oracle (XLM, USDC, EURC)
  const basePrices: Record<string, number> = {};

  const oracleReads = await Promise.allSettled(
    ORACLE_SYMBOLS.map(async (sym: OracleSymbol) => {
      const contract = new StellarSdk.Contract(ORACLE_CONTRACT);
      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: "100",
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            "get_price_latest",
            StellarSdk.nativeToScVal(sym, { type: "symbol" })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);

      if (
        StellarSdk.rpc.Api.isSimulationSuccess(sim) &&
        sim.result?.retval
      ) {
        const price = decodeOraclePriceResult(sim.result.retval);
        if (price > 0) return { sym, price };
      }

      throw new Error(`Oracle simulation failed for ${sym}`);
    })
  );

  const cached = readCachedPrices();

  for (const result of oracleReads) {
    if (result.status === "fulfilled" && result.value) {
      basePrices[result.value.sym] = result.value.price;
    }
  }

  // For any base symbol that failed, try cache then fallback
  for (const sym of ORACLE_SYMBOLS) {
    if (!basePrices[sym] || basePrices[sym] <= 0) {
      const cachedPrice = cached?.[sym];
      const fallback = FALLBACK_PRICES[sym] ?? 1;
      basePrices[sym] = cachedPrice && cachedPrice > 0 ? cachedPrice : fallback;
      console.warn(
        `[oracle-prices] ${sym} oracle failed — using`,
        cachedPrice ? `cached: $${cachedPrice}` : `fallback: $${fallback}`
      );
    }
  }

  // Step 2: Derive all token prices from their base oracle price
  const allPrices: Record<string, number> = { ...basePrices };

  for (const [derivative, base] of Object.entries(DERIVATIVE_TO_BASE)) {
    allPrices[derivative] = basePrices[base];
  }

  // Cache all prices for next load
  writeCachedPrices(allPrices);

  return allPrices;
}

export function useOraclePrices() {
  const { latestLedger } = useLedgerTick();

  return useQuery({
    queryKey: ["prices", latestLedger],
    queryFn: fetchOraclePrices,
    staleTime: 4_000,
    gcTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: () => readCachedPrices() ?? buildFallbackPrices(),
  });
}

function buildFallbackPrices(): Record<string, number> {
  const prices: Record<string, number> = { ...FALLBACK_PRICES };
  for (const [derivative, base] of Object.entries(DERIVATIVE_TO_BASE)) {
    prices[derivative] = FALLBACK_PRICES[base] ?? 1;
  }
  return prices;
}

export function useTokenPrices() {
  const { data, isLoading } = useOraclePrices();

  const prices = data ?? readCachedPrices() ?? buildFallbackPrices();
  const xlmUsd = prices.XLM ?? FALLBACK_PRICES.XLM;

  const getPrice = (asset: string): number => {
    const key = (asset ?? "").toUpperCase();
    const direct = prices[key];
    if (direct != null && direct > 0) return direct;

    const base = DERIVATIVE_TO_BASE[key];
    if (base) return prices[base] ?? FALLBACK_PRICES[base] ?? 1;

    return FALLBACK_PRICES[key] ?? 1;
  };

  return {
    prices,
    xlmUsd,
    isLoading,
    lastUpdated: null as number | null,
    refresh: async () => { /* invalidation handled by ledger tick */ },
    getPrice,
  };
}

export function useTokenPrice(symbol: string): number {
  const { getPrice } = useTokenPrices();
  return getPrice(symbol);
}

let _latestPrices: Record<string, number> | null = null;

export function _setLatestPrices(prices: Record<string, number>) {
  _latestPrices = prices;
}

export function getTokenPriceUsdSync(asset: string): number {
  const key = (asset ?? "").toUpperCase();

  if (_latestPrices?.[key] != null && _latestPrices[key] > 0) return _latestPrices[key];

  const base = DERIVATIVE_TO_BASE[key];
  if (base && _latestPrices?.[base] != null && _latestPrices[base] > 0) return _latestPrices[base];

  const cached = readCachedPrices();
  if (cached?.[key] != null && cached[key] > 0) return cached[key];
  if (base && cached?.[base] != null && cached[base] > 0) return cached[base];

  return FALLBACK_PRICES[key] ?? FALLBACK_PRICES[base!] ?? 1;
}
