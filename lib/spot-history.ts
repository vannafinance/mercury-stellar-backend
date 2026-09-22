import * as StellarSdk from "@stellar/stellar-sdk";

import { fetchContractEvents } from "@/lib/mercury-client";
import { fetchTxTimestamps } from "@/lib/mercury-timestamps";
import { CONTRACT_ADDRESSES, SOROBAN_RPC_URL } from "@/lib/stellar-utils";

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
const WAD = BigInt("1000000000000000000");
const SEVEN_DECIMAL_DIVISOR = BigInt("100000000000");
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

const actionName = (value: unknown): string => {
  if (typeof value === "string") return value;
  // #[contracttype] unit enums decode from ScVec as ["Variant"].
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const explicit = row.tag ?? row.name ?? row.type;
    if (explicit != null) return String(explicit);
    // Keep compatibility with decoders that expose a tagged enum as
    // { Swap: undefined } rather than an ScVec.
    return Object.keys(row)[0] ?? "";
  }
  return "";
};

const wadToFixed7 = (value: bigint): string => {
  const abs = value < ZERO ? -value : value;
  const whole = abs / WAD;
  const fraction = ((abs % WAD) / SEVEN_DECIMAL_DIVISOR).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
};

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

export function decodeTraderExec(
  raw: unknown,
  marginAccountAddress: string,
  txHash: string,
  timestamp: number,
): SpotHistoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;
  if (actionName(event.action).toLowerCase() !== "swap") return null;

  const deltas = (event.deltas ?? {}) as Record<string, unknown>;
  const tokens = Array.isArray(deltas.tokens) ? deltas.tokens.map(String) : [];
  const amounts = Array.isArray(deltas.deltas) ? deltas.deltas : [];
  if (tokens.length !== amounts.length) return null;

  let input: { token: string; amount: bigint } | null = null;
  let output: { token: string; amount: bigint } | null = null;
  for (let index = 0; index < tokens.length; index += 1) {
    let delta: bigint;
    try {
      delta = BigInt(String(amounts[index]));
    } catch {
      continue;
    }
    if (delta < ZERO && (!input || -delta > input.amount)) input = { token: tokens[index], amount: -delta };
    if (delta > ZERO && (!output || delta > output.amount)) output = { token: tokens[index], amount: delta };
  }
  if (!input || !output) return null;

  const target = String(event.target ?? "");
  const protocol: SpotProtocol =
    target === CONTRACT_ADDRESSES.AQUARIUS_ROUTER ||
    target === CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL ||
    input.token === CONTRACT_ADDRESSES.AQUARIUS_USDC ||
    output.token === CONTRACT_ADDRESSES.AQUARIUS_USDC
      ? "aquarius"
      : "soroswap";

  return {
    id: `spot:${txHash}`,
    protocol,
    marginAccountAddress,
    tokenIn: TOKEN_SYMBOLS[input.token] ?? input.token,
    tokenOut: TOKEN_SYMBOLS[output.token] ?? output.token,
    amountIn: wadToFixed7(input.amount),
    amountOut: wadToFixed7(output.amount),
    txHash,
    timestamp,
  };
}

async function fromMercury(marginAccountAddress: string): Promise<SpotHistoryEntry[]> {
  const results = await Promise.allSettled([
    fetchContractEvents({
      contract: CONTRACT_ADDRESSES.ACCOUNT_MANAGER,
      account: marginAccountAddress,
    }),
    ...SPOT_TOKEN_CONTRACTS.map((contract) => fetchContractEvents({
      contract,
      account: marginAccountAddress,
      maxPages: 10,
    })),
  ]);

  const accountManagerEvents = results[0].status === "fulfilled" ? results[0].value : [];
  const execRows = accountManagerEvents
    .filter((event) => event.eventName === "Trader_Exec")
    .map((event) => decodeTraderExec(event.data, marginAccountAddress, event.tx ?? "", 0))
    .filter((row): row is SpotHistoryEntry => Boolean(row));

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

  // Prefer the richer AccountManager event when a newly deployed contract
  // emits it; otherwise the token-transfer reconstruction covers the current
  // testnet deployment without relying on browser storage.
  const byHash = new Map<string, SpotHistoryEntry>();
  execRows.forEach((row) => byHash.set(row.txHash, row));
  transfersToSpotHistory(transferLegs, marginAccountAddress).forEach((row) => {
    if (!byHash.has(row.txHash)) byHash.set(row.txHash, row);
  });
  const rows = Array.from(byHash.values());

  const timestamps = await fetchTxTimestamps(rows.map((row) => row.txHash).filter(Boolean));
  rows.forEach((row) => {
    row.timestamp = timestamps.get(row.txHash)?.ts ?? 0;
  });
  return rows;
}

async function fromRpc(marginAccountAddress: string): Promise<SpotHistoryEntry[]> {
  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const health = await server.getHealth();
  const accountTopic = StellarSdk.xdr.ScVal
    .scvAddress(new StellarSdk.Address(marginAccountAddress).toScAddress())
    .toXDR("base64");
  const transferTopic = StellarSdk.xdr.ScVal.scvSymbol("transfer").toXDR("base64");
  const response = await server.getEvents({
    filters: [
      {
        type: "contract",
        contractIds: [CONTRACT_ADDRESSES.ACCOUNT_MANAGER],
        topics: [["*", accountTopic]],
      },
      {
        type: "contract",
        contractIds: SPOT_TOKEN_CONTRACTS,
        topics: [[transferTopic, accountTopic, "*"]],
      },
      {
        type: "contract",
        contractIds: SPOT_TOKEN_CONTRACTS,
        topics: [[transferTopic, "*", accountTopic]],
      },
    ],
    // Use the node's real retention boundary, capped to roughly three days of
    // ledgers. The former 9,000-ledger window was only ~12 hours and made
    // otherwise-valid recent swaps disappear before Mercury had a chance to
    // provide the long-term copy. Keeping this at 50k also stays below the
    // public RPC node's event-query processing limit.
    startLedger: Math.max(health.oldestLedger, health.latestLedger - 50_000),
    limit: 1000,
  });

  const execRows = response.events
    .filter((event) => event.contractId?.contractId() === CONTRACT_ADDRESSES.ACCOUNT_MANAGER)
    .filter((event) => StellarSdk.scValToNative(event.topic[0]) === "Trader_Exec")
    .map((event) => decodeTraderExec(
      StellarSdk.scValToNative(event.value),
      marginAccountAddress,
      event.txHash,
      new Date(event.ledgerClosedAt).getTime(),
    ))
    .filter((row): row is SpotHistoryEntry => Boolean(row));

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

  const byHash = new Map<string, SpotHistoryEntry>();
  execRows.forEach((row) => byHash.set(row.txHash, row));
  transfersToSpotHistory(transferLegs, marginAccountAddress).forEach((row) => {
    if (!byHash.has(row.txHash)) byHash.set(row.txHash, row);
  });
  return Array.from(byHash.values());
}

/** Spot swaps reconstructed exclusively from immutable on-chain events. */
export async function getSpotHistory(
  marginAccountAddress: string | null | undefined,
): Promise<SpotHistoryEntry[]> {
  if (!marginAccountAddress) return [];
  const [mercury, rpc] = await Promise.allSettled([
    fromMercury(marginAccountAddress),
    fromRpc(marginAccountAddress),
  ]);
  const byHash = new Map<string, SpotHistoryEntry>();
  if (mercury.status === "fulfilled") mercury.value.forEach((row) => byHash.set(row.txHash, row));
  if (rpc.status === "fulfilled") rpc.value.forEach((row) => {
    if (!byHash.has(row.txHash)) byHash.set(row.txHash, row);
  });
  return Array.from(byHash.values()).sort((a, b) => b.timestamp - a.timestamp);
}
