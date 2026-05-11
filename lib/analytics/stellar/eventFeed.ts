import * as StellarSdk from "@stellar/stellar-sdk";
import { CONTRACT_ADDRESSES, SOROBAN_RPC_URL } from "@/lib/stellar-utils";
import {
  fallbackPriceForCanonical,
  fallbackPriceForSymbol,
  resolveUsdAlias,
  shortStellar,
  syntheticGAccount,
} from "./canon";
import { fetchTokenPrices, getCachedTokenPrice } from "@/lib/oracle-price";

type RawEvent = {
  txHash?: string;
  contractId?: string;
  topic?: unknown[];
  value?: unknown;
  ledgerClosedAt?: string;
};

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

async function fetchContractEvents(
  server: StellarSdk.rpc.Server,
  contractIds: string[],
  topicSymbol: string,
  startLedger: number,
): Promise<RawEvent[]> {
  const topicBase64 = StellarSdk.xdr.ScVal.scvSymbol(topicSymbol).toXDR("base64");
  try {
    const response = (await (server as unknown as {
      getEvents: (arg: {
        startLedger: number;
        filters: Array<{ type: "contract"; contractIds: string[]; topics: string[][] }>;
        limit: number;
      }) => Promise<{ events?: RawEvent[]; error?: unknown }>;
    }).getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds, topics: [[topicBase64]] }],
      limit: 200,
    })) ?? { events: [] };
    if (response.error) return [];
    return response.events ?? [];
  } catch {
    return [];
  }
}

export async function readLiveEventFeed(lookbackLedgers = DEFAULT_LOOKBACK_LEDGERS): Promise<LiveEventFeed> {
  await fetchTokenPrices(["XLM", "BLUSDC", "AQUSDC", "SOUSDC"]).catch(() => undefined);

  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const latest = await server.getLatestLedger();
  const startLedger = Math.max(1, latest.sequence - lookbackLedgers);

  const accountManager = CONTRACT_ADDRESSES.ACCOUNT_MANAGER;
  const pools = [
    CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM,
    CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC,
    CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC,
    CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC,
  ];

  const [
    liqEvents,
    borrowEvents,
    repayEvents,
    accountCreateEvents,
    poolDepositEvents,
    poolWithdrawEvents,
  ] = await Promise.all([
    fetchContractEvents(server, [accountManager], "Trader_Liquidate_Event", startLedger),
    fetchContractEvents(server, [accountManager], "Trader_Borrow", startLedger),
    fetchContractEvents(server, [accountManager], "Trader_Repay_Event", startLedger),
    fetchContractEvents(server, [accountManager], "Smart_account_creation", startLedger),
    fetchContractEvents(server, pools, "deposit_event", startLedger),
    fetchContractEvents(server, pools, "withdraw_event", startLedger),
  ]);

  const liquidations: LiveLiquidationRow[] = liqEvents.map((ev, i) => {
    const topics = parseTopic(ev.topic);
    const smartAccount = String(topics[1] ?? "");
    const timestamp = parseTimestamp(ev.ledgerClosedAt);
    return {
      txHash: ev.txHash || `live-liq-${i}`,
      chain: "stellar",
      timestamp,
      positionAddress: shortStellar(smartAccount || syntheticGAccount(9000 + i)),
      liquidatorAddress: shortStellar(smartAccount || syntheticGAccount(8000 + i)),
      // AccountManager liquidation event doesn't emit debt/recovery fields today.
      debtAmount: 0,
      recoveryAmount: 0,
      badDebt: 0,
      durationSeconds: 0,
      status: "success",
    };
  });

  const whaleActivity: LiveWhaleActivityRow[] = [];

  for (const [i, ev] of accountCreateEvents.entries()) {
    const topics = parseTopic(ev.topic);
    const value = parseNativeScVal(ev.value) as { smart_account?: string } | null;
    const trader = String(topics[1] ?? "");
    const smart = String(value?.smart_account ?? "");
    whaleActivity.push({
      timestamp: parseTimestamp(ev.ledgerClosedAt),
      address: shortStellar(trader || smart || syntheticGAccount(7000 + i)),
      chain: "stellar",
      action: "OPEN_POSITION",
      amountUsd: 0,
      details: `Created smart account ${shortStellar(smart || syntheticGAccount(6000 + i))}`,
    });
  }

  for (const [i, ev] of borrowEvents.entries()) {
    const topics = parseTopic(ev.topic);
    const symbol = String(parseNativeScVal(ev.value) ?? "XLM");
    const smart = String(topics[1] ?? "");
    whaleActivity.push({
      timestamp: parseTimestamp(ev.ledgerClosedAt),
      address: shortStellar(smart || syntheticGAccount(5000 + i)),
      chain: "stellar",
      action: "INCREASE_LEVERAGE",
      amountUsd: 0,
      details: `Borrowed ${symbol} via AccountManager`,
    });
  }

  for (const [i, ev] of repayEvents.entries()) {
    const topics = parseTopic(ev.topic);
    const smart = String(topics[1] ?? "");
    const value = parseNativeScVal(ev.value) as { token_amount?: unknown; token_symbol?: string } | null;
    const tokenSymbol = String(value?.token_symbol ?? "XLM");
    const amountToken = amountWadToToken(value?.token_amount);
    whaleActivity.push({
      timestamp: parseTimestamp(ev.ledgerClosedAt),
      address: shortStellar(smart || syntheticGAccount(4000 + i)),
      chain: "stellar",
      action: "DECREASE_LEVERAGE",
      amountUsd: tokenUsd(tokenSymbol, amountToken),
      details: `Repaid ${amountToken.toFixed(4)} ${tokenSymbol}`,
    });
  }

  for (const [i, ev] of poolDepositEvents.entries()) {
    const topics = parseTopic(ev.topic);
    const lender = String(topics[1] ?? "");
    const value = parseNativeScVal(ev.value) as { amount?: unknown; asset_symbol?: string } | null;
    const symbol = String(value?.asset_symbol ?? "XLM");
    const amountToken = amountWadToToken(value?.amount);
    whaleActivity.push({
      timestamp: parseTimestamp(ev.ledgerClosedAt),
      address: shortStellar(lender || syntheticGAccount(3000 + i)),
      chain: "stellar",
      action: "DEPOSIT",
      amountUsd: tokenUsd(symbol, amountToken),
      details: `Deposited ${amountToken.toFixed(4)} ${symbol} into lending pool`,
    });
  }

  for (const [i, ev] of poolWithdrawEvents.entries()) {
    const topics = parseTopic(ev.topic);
    const lender = String(topics[1] ?? "");
    const value = parseNativeScVal(ev.value) as { vtoken_amount?: unknown; asset_symbol?: string } | null;
    const symbol = String(value?.asset_symbol ?? "XLM");
    const amountToken = amountWadToToken(value?.vtoken_amount);
    whaleActivity.push({
      timestamp: parseTimestamp(ev.ledgerClosedAt),
      address: shortStellar(lender || syntheticGAccount(2000 + i)),
      chain: "stellar",
      action: "WITHDRAW",
      amountUsd: tokenUsd(symbol, amountToken),
      details: `Withdrew ${amountToken.toFixed(4)} ${symbol} from lending pool`,
    });
  }

  whaleActivity.sort((a, b) => b.timestamp - a.timestamp);
  liquidations.sort((a, b) => b.timestamp - a.timestamp);

  return {
    liquidations: liquidations.slice(0, 25),
    whaleActivity: whaleActivity.slice(0, 40),
    fetchedAt: Date.now(),
    // liquidations are currently partial because debt/recovery isn't emitted.
    isPartial: true,
  };
}

