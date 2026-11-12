import * as StellarSdk from "@stellar/stellar-sdk";

import { fetchContractEvents } from "@/lib/mercury-client";
import { fetchTxTimestamps } from "@/lib/mercury-timestamps";
import { CONTRACT_ADDRESSES, SOROBAN_RPC_URL } from "@/lib/stellar-utils";
import { CREDIT_EVENTS } from "@/lib/credit-layer";

// Spot (margin-account) swaps. The CreditLayer emits
//   margin_executed  topics=[name, margin]  data={margin, target, tokens_in, tokens_out}
// for every venue call, with NO amounts. Amounts come from the SEP-41 transfer
// legs of the same transaction (margin -> pool, pool -> margin), merged by tx
// hash; the margin_executed event confirms the swap and names the venue.

export type SpotProtocol = "aquarius" | "soroswap";

export interface SpotHistoryEntry {
  id: string;
  protocol: SpotProtocol;
  marginAccountAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  txHash: string;
  timestamp: number;
}

const ZERO = BigInt(0);
const NATIVE_TOKEN_SCALE = BigInt(10_000_000);

const TOKEN_SYMBOLS: Record<string, string> = {
  [CONTRACT_ADDRESSES.BLEND_XLM]: "XLM",
  [CONTRACT_ADDRESSES.BLEND_USDC]: "BLUSDC",
  [CONTRACT_ADDRESSES.AQUARIUS_USDC]: "AqUSDC",
  [CONTRACT_ADDRESSES.SOROSWAP_USDC]: "SoUSDC",
};

const SPOT_TOKEN_CONTRACTS = Array.from(new Set(Object.keys(TOKEN_SYMBOLS)));

export interface SpotTransferLeg {
  txHash: string;
  tokenContract: string;
  direction: "in" | "out";
  amount: bigint;
  timestamp: number;
}

const nativeToFixed7 = (value: bigint): string => {
  const abs = value < ZERO ? -value : value;
  const whole = abs / NATIVE_TOKEN_SCALE;
  const fraction = (abs % NATIVE_TOKEN_SCALE).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const asAddress = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  // Some SEP-41 decoders expose Option<Address> as a one-item vector.
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
};

/**
 * Decode one SEP-41 token transfer involving the margin account. Supports
 * both token event layouts seen on testnet:
 *   topics=["transfer", from, to], data=amount
 *   topics=["transfer"], data={ from, to, amount }
 */
export function decodeSpotTransfer(
  tokenContract: string,
  topics: unknown[],
  data: unknown,
  marginAccountAddress: string,
  txHash: string,
  timestamp: number,
): SpotTransferLeg | null {
  if (topics[0] !== "transfer" || !txHash || !TOKEN_SYMBOLS[tokenContract]) return null;

  const body = asRecord(data);
  const from = asAddress(topics[1]) ?? asAddress(body?.from);
  const to = asAddress(topics[2]) ?? asAddress(body?.to);
  const rawAmount = body?.amount ?? data;

  let amount: bigint;
  try {
    amount = BigInt(String(rawAmount));
  } catch {
    return null;
  }
  if (amount <= ZERO || (from !== marginAccountAddress && to !== marginAccountAddress)) return null;

  // A self-transfer has no economic direction and cannot be one leg of a swap.
  if (from === marginAccountAddress && to === marginAccountAddress) return null;
  return {
    txHash,
    tokenContract,
    direction: from === marginAccountAddress ? "out" : "in",
    amount,
    timestamp,
  };
}

/**
 * Reconstruct swaps by grouping the margin account's on-chain token transfers
 * by transaction. Deposits, withdrawals, borrows and LP operations are
 * excluded naturally because they do not contain one outgoing AND one incoming
 * supported spot token in the same transaction.
 */
export function transfersToSpotHistory(
  legs: SpotTransferLeg[],
  marginAccountAddress: string,
): SpotHistoryEntry[] {
  const byTransaction = new Map<string, SpotTransferLeg[]>();
  for (const leg of legs) {
    const current = byTransaction.get(leg.txHash) ?? [];
    current.push(leg);
    byTransaction.set(leg.txHash, current);
  }

  const rows: SpotHistoryEntry[] = [];
  for (const [txHash, transactionLegs] of byTransaction) {
    const totals = new Map<string, { in: bigint; out: bigint }>();
    for (const leg of transactionLegs) {
      const total = totals.get(leg.tokenContract) ?? { in: ZERO, out: ZERO };
      total[leg.direction] += leg.amount;
      totals.set(leg.tokenContract, total);
    }

    // A swap sends out exactly one token. Two tokens leaving in the same
    // transaction is an LP deposit (e.g. Aquarius returns a few stroops of the
    // over-supplied side, which would otherwise read as XLM -> AqUSDC).
    const outgoingTokens = Array.from(totals.values()).filter((total) => total.out > ZERO).length;
    if (outgoingTokens !== 1) continue;

    let input: { token: string; amount: bigint } | null = null;
    let output: { token: string; amount: bigint } | null = null;
    for (const [token, total] of totals) {
      if (total.out > ZERO && (!input || total.out > input.amount)) {
        input = { token, amount: total.out };
      }
      if (total.in > ZERO && (!output || total.in > output.amount)) {
        output = { token, amount: total.in };
      }
    }
    if (!input || !output || input.token === output.token) continue;

    const protocol: SpotProtocol =
      input.token === CONTRACT_ADDRESSES.AQUARIUS_USDC ||
      output.token === CONTRACT_ADDRESSES.AQUARIUS_USDC
        ? "aquarius"
        : "soroswap";
    rows.push({
      id: `spot:${txHash}`,
      protocol,
      marginAccountAddress,
      tokenIn: TOKEN_SYMBOLS[input.token] ?? input.token,
      tokenOut: TOKEN_SYMBOLS[output.token] ?? output.token,
      amountIn: nativeToFixed7(input.amount),
      amountOut: nativeToFixed7(output.amount),
      txHash,
      timestamp: Math.max(...transactionLegs.map((leg) => leg.timestamp)),
    });
  }
  return rows;
}

/** A CreditLayer `margin_executed` event that is a single-token-in / single-token-out swap. */
export interface MarginSwapExec {
  txHash: string;
  target: string;
  /** Token the margin account received. */
  tokenIn: string;
  /** Token the margin account sent. */
  tokenOut: string;
}

const addressList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((v) => asAddress(v)).filter((v): v is string => Boolean(v)) : [];

/**
 * Decode a `margin_executed` event body. Returns it only when it is a swap:
 * exactly one token in and one token out, both spot tokens (an LP add/remove
 * moves two tokens one way and an LP/share token the other; Blend moves one).
 */
export function decodeMarginExecuted(raw: unknown, txHash: string): MarginSwapExec | null {
  const body = asRecord(raw);
  if (!body || !txHash) return null;
  const tokensIn = addressList(body.tokens_in);
  const tokensOut = addressList(body.tokens_out);
  if (tokensIn.length !== 1 || tokensOut.length !== 1) return null;
  if (!TOKEN_SYMBOLS[tokensIn[0]] || !TOKEN_SYMBOLS[tokensOut[0]]) return null;
  return { txHash, target: String(body.target ?? ""), tokenIn: tokensIn[0], tokenOut: tokensOut[0] };
}

const protocolForTarget = (target: string): SpotProtocol | null =>
  target === CONTRACT_ADDRESSES.AQUARIUS_ROUTER || target === CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL
    ? "aquarius"
    : target === CONTRACT_ADDRESSES.SOROSWAP_ROUTER
      ? "soroswap"
      : null;

/**
 * Merge transfer-reconstructed rows with margin_executed swap events by tx
 * hash: an event names the venue (protocol), the transfers carry the amounts.
 */
export function applyMarginExecs(rows: SpotHistoryEntry[], execs: MarginSwapExec[]): SpotHistoryEntry[] {
  const byHash = new Map(execs.map((e) => [e.txHash, e]));
  return rows.map((row) => {
    const exec = byHash.get(row.txHash);
    const protocol = exec ? protocolForTarget(exec.target) : null;
    return protocol ? { ...row, protocol } : row;
  });
}

interface SourceResult {
  rows: SpotHistoryEntry[];
  execs: MarginSwapExec[];
}

async function fromMercury(marginAccountAddress: string): Promise<SourceResult> {
  const results = await Promise.allSettled([
    // Cap CreditLayer pagination — walking the default 50 pages blocked the
    // whole Spot History query for 15–30s+ on cold load. Recent swaps live in
    // the first pages; RPC fills anything this window misses.
    fetchContractEvents({
      contract: CONTRACT_ADDRESSES.CREDIT_LAYER,
      account: marginAccountAddress,
      maxPages: 5,
    }),
    ...SPOT_TOKEN_CONTRACTS.map((contract) => fetchContractEvents({
      contract,
      account: marginAccountAddress,
      maxPages: 5,
    })),
  ]);

  const creditLayerEvents = results[0].status === "fulfilled" ? results[0].value : [];
  const execs = creditLayerEvents
    .filter((event) => event.eventName === CREDIT_EVENTS.executed)
    .map((event) => decodeMarginExecuted(event.data, event.tx ?? ""))
    .filter((row): row is MarginSwapExec => Boolean(row));

  const transferLegs = results.slice(1).flatMap((result, index) => {
    if (result.status !== "fulfilled") return [];
    const tokenContract = SPOT_TOKEN_CONTRACTS[index];
    return result.value
      .map((event) => decodeSpotTransfer(
        tokenContract,
        event.topics,
        event.data,
        marginAccountAddress,
        event.tx ?? "",
        0,
      ))
      .filter((leg): leg is SpotTransferLeg => Boolean(leg));
  });

  const rows = transfersToSpotHistory(transferLegs, marginAccountAddress);
  const timestamps = await fetchTxTimestamps(rows.map((row) => row.txHash).filter(Boolean));
  rows.forEach((row) => {
    row.timestamp = timestamps.get(row.txHash)?.ts ?? 0;
  });
  return { rows, execs };
}

// Ledgers per getEvents request. The public testnet RPC scans at most ~10k
// ledgers per call and answers a single 50k-ledger request with only its OLDEST
// 10k (plus a cursor) — so the old one-shot query silently returned no swaps
// whenever the account traded more than ~14 hours after that slice. Busy
// stretches of the native XLM contract also trip "-32001 request exceeded
// processing limit" on 10k windows; 5k windows with an explicit endLedger
// stay under it (verified 2026-10-14), and a failing window is halved once.
const RPC_WINDOW_LEDGERS = 5_000;
// Roughly three days of ledgers, as before.
const RPC_LOOKBACK_LEDGERS = 50_000;
const RPC_WINDOW_CONCURRENCY = 4;

type RpcEvent = StellarSdk.rpc.Api.EventResponse;

async function fromRpc(marginAccountAddress: string): Promise<SourceResult> {
  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const health = await server.getHealth();
  const accountTopic = StellarSdk.xdr.ScVal
    .scvAddress(new StellarSdk.Address(marginAccountAddress).toScAddress())
    .toXDR("base64");
  const transferTopic = StellarSdk.xdr.ScVal.scvSymbol("transfer").toXDR("base64");
  const filters: StellarSdk.rpc.Api.EventFilter[] = [
    {
      type: "contract",
      contractIds: [CONTRACT_ADDRESSES.CREDIT_LAYER],
      topics: [[StellarSdk.xdr.ScVal.scvSymbol(CREDIT_EVENTS.executed).toXDR("base64"), accountTopic]],
    },
    // Trailing "**" matches any number of further topics. The native XLM SAC
    // emits transfer with a 4th topic ("native"), so the old exact 3-segment
    // filter never matched its transfers — every XLM leg was missing and no
    // XLM <-> USDC swap could be reconstructed (verified 2026-10-14).
    {
      type: "contract",
      contractIds: SPOT_TOKEN_CONTRACTS,
      topics: [[transferTopic, accountTopic, "*", "**"]],
    },
    {
      type: "contract",
      contractIds: SPOT_TOKEN_CONTRACTS,
      topics: [[transferTopic, "*", accountTopic, "**"]],
    },
  ];

  /** One [start, end) ledger window; on a processing-limit error, retried as two halves. */
  const readWindow = async (start: number, end: number, canSplit = true): Promise<RpcEvent[]> => {
    try {
      const response = await server.getEvents({ filters, startLedger: start, endLedger: end, limit: 1000 });
      return response.events;
    } catch (error) {
      if (!canSplit || end - start < 2) throw error;
      const mid = Math.floor((start + end) / 2);
      const halves = await Promise.allSettled([readWindow(start, mid, false), readWindow(mid, end, false)]);
      return halves.flatMap((half) => (half.status === "fulfilled" ? half.value : []));
    }
  };

  // Newest window first, so the most recent swaps are read even if an older
  // window fails or the caller's timeout cuts the scan short.
  const oldest = Math.max(health.oldestLedger, health.latestLedger - RPC_LOOKBACK_LEDGERS);
  const windows: [number, number][] = [];
  for (let end = health.latestLedger + 1; end > oldest; end -= RPC_WINDOW_LEDGERS) {
    windows.push([Math.max(oldest, end - RPC_WINDOW_LEDGERS), end]);
  }
  const events: RpcEvent[] = [];
  for (let i = 0; i < windows.length; i += RPC_WINDOW_CONCURRENCY) {
    const batch = await Promise.allSettled(
      windows.slice(i, i + RPC_WINDOW_CONCURRENCY).map(([start, end]) => readWindow(start, end)),
    );
    batch.forEach((result) => {
      if (result.status === "fulfilled") events.push(...result.value);
    });
  }
  const response = { events };

  const execs = response.events
    .filter((event) => event.contractId?.contractId() === CONTRACT_ADDRESSES.CREDIT_LAYER)
    .filter((event) => StellarSdk.scValToNative(event.topic[0]) === CREDIT_EVENTS.executed)
    .map((event) => decodeMarginExecuted(StellarSdk.scValToNative(event.value), event.txHash))
    .filter((row): row is MarginSwapExec => Boolean(row));

  const transferLegs = response.events
    .map((event) => {
      const tokenContract = event.contractId?.contractId() ?? "";
      const topics = event.topic.map((topic) => StellarSdk.scValToNative(topic));
      return decodeSpotTransfer(
        tokenContract,
        topics,
        StellarSdk.scValToNative(event.value),
        marginAccountAddress,
        event.txHash,
        new Date(event.ledgerClosedAt).getTime(),
      );
    })
    .filter((leg): leg is SpotTransferLeg => Boolean(leg));

  return { rows: transfersToSpotHistory(transferLegs, marginAccountAddress), execs };
}

/** Race a promise against a timeout so one slow indexer can't blank the UI. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Spot swaps reconstructed exclusively from immutable on-chain events. */
export async function getSpotHistory(
  marginAccountAddress: string | null | undefined,
): Promise<SpotHistoryEntry[]> {
  if (!marginAccountAddress) return [];
  // Cap each source so a hung Mercury walk can't leave Spot History empty for
  // the entire page session. Mercury must not block indefinitely; RPC now walks
  // ~10 ledger windows (see RPC_WINDOW_LEDGERS), so it gets a longer budget.
  const [mercury, rpc] = await Promise.allSettled([
    withTimeout(fromMercury(marginAccountAddress), 6_000),
    withTimeout(fromRpc(marginAccountAddress), 20_000),
  ]);
  const byHash = new Map<string, SpotHistoryEntry>();
  const execs: MarginSwapExec[] = [];
  // Prefer RPC first (recent, usually faster), then Mercury for longer history.
  if (rpc.status === "fulfilled") {
    rpc.value.rows.forEach((row) => byHash.set(row.txHash, row));
    execs.push(...rpc.value.execs);
  }
  if (mercury.status === "fulfilled") {
    mercury.value.rows.forEach((row) => {
      if (!byHash.has(row.txHash)) byHash.set(row.txHash, row);
    });
    execs.push(...mercury.value.execs);
  }
  return applyMarginExecs(Array.from(byHash.values()), execs).sort((a, b) => b.timestamp - a.timestamp);
}
