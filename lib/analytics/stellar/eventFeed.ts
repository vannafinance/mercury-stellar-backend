import * as StellarSdk from "@stellar/stellar-sdk";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import { CREDIT_ASSETS, CREDIT_EVENTS, type CreditAsset } from "@/lib/credit-layer";
import { symbolForToken } from "@/lib/margin-credit-reads";
import { eventName, getEventsWindowed, symbolTopic, type RpcEvent } from "@/lib/credit-events-rpc";
import {
  ACTIVE_ASSETS,
  fallbackPriceForCanonical,
  fallbackPriceForSymbol,
  resolveUsdAlias,
  shortStellar,
} from "./canon";
import { fetchTokenPrices, getCachedTokenPrice } from "@/lib/oracle-price";

export type LiveLiquidationRow = {
  txHash: string;
  chain: "stellar";
  timestamp: number;
  positionAddress: string;
  liquidatorAddress: string;
  debtAmount: number;
  recoveryAmount: number;
  badDebt: number;
  durationSeconds: number;
  status: "success" | "partial";
  /** Full margin (smart) account address from the event topic ("" when the event did not carry one). */
  account: string;
};

export type LiveWhaleActivityRow = {
  timestamp: number;
  address: string;
  chain: "stellar";
  action:
    | "OPEN_POSITION"
    | "CLOSE_POSITION"
    | "INCREASE_LEVERAGE"
    | "DECREASE_LEVERAGE"
    | "DEPOSIT"
    | "WITHDRAW";
  amountUsd: number;
  details: string;
  /** Full address (margin account or lender wallet) from the event topic ("" when not emitted). */
  account: string;
  /** Transaction hash ("" when the RPC did not return one). */
  txHash: string;
};

export type LiveEventFeed = {
  liquidations: LiveLiquidationRow[];
  whaleActivity: LiveWhaleActivityRow[];
  fetchedAt: number;
  isPartial: boolean;
};

const WAD = 1e18;
const DEFAULT_LOOKBACK_LEDGERS = 17280; // ~24h at ~5s/ledger

function parseNativeScVal(value: unknown): unknown {
  try {
    return StellarSdk.scValToNative(value as StellarSdk.xdr.ScVal);
  } catch {
    return value;
  }
}

function parseTopic(topic: unknown[] | undefined): unknown[] {
  if (!Array.isArray(topic)) return [];
  return topic.map(parseNativeScVal);
}

function parseTimestamp(ledgerClosedAt?: string): number {
  if (!ledgerClosedAt) return Date.now();
  const ms = new Date(ledgerClosedAt).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : Date.now();
}

function amountWadToToken(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n / WAD;
}

function tokenUsd(symbol: string, tokenAmount: number): number {
  const canonical = resolveUsdAlias(symbol);
  const px =
    getCachedTokenPrice(symbol) ||
    getCachedTokenPrice(canonical) ||
    (fallbackPriceForSymbol(symbol) ?? fallbackPriceForCanonical(canonical));
  return tokenAmount * (px || 0);
}

/** Reserve contract → UI symbol, for supplied / redeemed rows. */
const RESERVE_SYMBOL: Record<string, string> = Object.fromEntries(
  (Object.keys(CREDIT_ASSETS) as CreditAsset[]).map((a) => [CREDIT_ASSETS[a].reserve, a]),
);

const contractIdOf = (ev: RpcEvent): string => {
  try {
    return ev.contractId?.contractId() ?? "";
  } catch {
    return "";
  }
};

/**
 * Live protocol event feed (credit layer, redeploy 2026-11-06), read from RPC
 * in 5k-ledger windows (lib/credit-events-rpc.ts):
 *   CreditLayer: liquidated {margin, liquidator}, borrowed / repaid {margin, token, amount WAD},
 *                margin_created [name, trader] data=margin
 *   Reserves:    supplied / redeemed [name, lender] {lender, assets WAD, shares WAD}
 */
export async function readLiveEventFeed(lookbackLedgers = DEFAULT_LOOKBACK_LEDGERS): Promise<LiveEventFeed> {
  // Prime the price cache for all active assets so rows below price off a
  // freshly-primed live quote instead of a stale/fallback one.
  await fetchTokenPrices([...ACTIVE_ASSETS]).catch(() => undefined);

  const creditTopics = [
    CREDIT_EVENTS.liquidated,
    CREDIT_EVENTS.borrowed,
    CREDIT_EVENTS.repaid,
    CREDIT_EVENTS.marginCreated,
  ].map((n) => [symbolTopic(n), "*"]);
  const reserveTopics = [CREDIT_EVENTS.supplied, CREDIT_EVENTS.redeemed].map((n) => [symbolTopic(n), "*"]);

  const events = await getEventsWindowed(
    [
      { type: "contract", contractIds: [CONTRACT_ADDRESSES.CREDIT_LAYER], topics: creditTopics },
      { type: "contract", contractIds: Object.keys(RESERVE_SYMBOL), topics: reserveTopics },
    ],
    lookbackLedgers,
  ).catch(() => [] as RpcEvent[]);

  const liquidations: LiveLiquidationRow[] = [];
  const whaleActivity: LiveWhaleActivityRow[] = [];

  events.forEach((ev, i) => {
    const name = eventName(ev);
    const topics = parseTopic(ev.topic as unknown[]);
    const who = String(topics[1] ?? "");
    const value = parseNativeScVal(ev.value) as Record<string, unknown> | string | null;
    const d = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const timestamp = parseTimestamp(ev.ledgerClosedAt);
    const txHash = ev.txHash || "";

    if (name === CREDIT_EVENTS.liquidated) {
      const liquidator = String(d.liquidator ?? "");
      liquidations.push({
        txHash: txHash || `live-liq-${i}`,
        chain: "stellar",
        timestamp,
        positionAddress: shortStellar(who),
        liquidatorAddress: liquidator ? shortStellar(liquidator) : "",
        // The liquidation event carries no debt/recovery amounts.
        debtAmount: 0,
        recoveryAmount: 0,
        badDebt: 0,
        durationSeconds: 0,
        status: "success",
        account: who,
      });
      return;
    }

    if (name === CREDIT_EVENTS.marginCreated) {
      const margin = typeof value === "string" ? value : "";
      whaleActivity.push({
        timestamp,
        address: shortStellar(who || margin),
        chain: "stellar",
        action: "OPEN_POSITION",
        amountUsd: 0,
        details: `Created margin account ${shortStellar(margin)}`,
        account: who || margin,
        txHash,
      });
      return;
    }

    if (name === CREDIT_EVENTS.borrowed || name === CREDIT_EVENTS.repaid) {
      const symbol = symbolForToken(String(d.token ?? ""));
      const amountToken = amountWadToToken(d.amount);
      const borrowed = name === CREDIT_EVENTS.borrowed;
      whaleActivity.push({
        timestamp,
        address: shortStellar(who),
        chain: "stellar",
        action: borrowed ? "INCREASE_LEVERAGE" : "DECREASE_LEVERAGE",
        amountUsd: tokenUsd(symbol, amountToken),
        details: `${borrowed ? "Borrowed" : "Repaid"} ${amountToken.toFixed(4)} ${symbol}`,
        account: who,
        txHash,
      });
      return;
    }

    if (name === CREDIT_EVENTS.supplied || name === CREDIT_EVENTS.redeemed) {
      const symbol = RESERVE_SYMBOL[contractIdOf(ev)] ?? "XLM";
      const amountToken = amountWadToToken(d.assets);
      const supplied = name === CREDIT_EVENTS.supplied;
      whaleActivity.push({
        timestamp,
        address: shortStellar(who),
        chain: "stellar",
        action: supplied ? "DEPOSIT" : "WITHDRAW",
        amountUsd: tokenUsd(symbol, amountToken),
        details: supplied
          ? `Supplied ${amountToken.toFixed(4)} ${symbol} to the lending reserve`
          : `Withdrew ${amountToken.toFixed(4)} ${symbol} from the lending reserve`,
        account: who,
        txHash,
      });
    }
  });

  whaleActivity.sort((a, b) => b.timestamp - a.timestamp);
  liquidations.sort((a, b) => b.timestamp - a.timestamp);

  return {
    liquidations: liquidations.slice(0, 25),
    whaleActivity: whaleActivity.slice(0, 40),
    fetchedAt: Date.now(),
    // liquidations are partial because debt/recovery isn't emitted.
    isPartial: true,
  };
}
