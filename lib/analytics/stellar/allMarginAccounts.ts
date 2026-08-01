// Fetches every margin (smart) account that has ever been created by the
// AccountManager — not just the connected wallet's account — and snapshots
// its on-chain collateral / debt for the analytics dashboards.
//
// How this works on-chain:
//   • RegistryContract maintains a `SmartAccountsList` persistent storage
//     entry (Vec<Address>) updated on every successful `add_account`. There
//     is no public getter, but Soroban RPC's `getContractData` can read the
//     persistent ledger entry directly.
//   • Per-account ownership lives in `OwnerAddress(account)`: `Some(trader)`
//     while the account is open, `None::<Address>` after `close_account`.
//     We use this to (a) tag a snapshot with its trader and (b) skip closed
//     accounts so the dashboard reflects only live positions.
//   • The account itself exposes plain view methods (`get_all_collateral_tokens`,
//     `get_collateral_token_balance`, `get_all_borrowed_tokens`,
//     `get_borrowed_token_debt`). These are read-only — `simulateTransaction`
//     just needs a funded G-source, so we use a public testnet account.
//
// Everything here is read-only. Callers wire the resulting `AccountSnapshot[]`
// straight into the existing `derive*` helpers in `lib/analytics/onchain`.

import * as StellarSdk from "@stellar/stellar-sdk";

import {
  CONTRACT_ADDRESSES,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
} from "@/lib/stellar-utils";
import {
  fetchTokenPrices,
  getCachedTokenPrice,
} from "@/lib/oracle-price";
import type {
  AccountSnapshot,
  CollateralPosition,
  DebtPosition,
} from "@/lib/analytics/onchain/types";
import { collateralPositionTypeForSymbol } from "@/lib/analytics/stellar/collateralClassification";
import { fetchFarmTrackingCollateralAmountMap } from "@/lib/analytics/stellar/farmTrackingCollateral";
import { ACTIVE_ASSETS } from "@/lib/analytics/stellar/canon";

const STELLAR_CHAIN_ID = 0;

// Public, funded testnet G-account used purely as the simulation source for
// read-only contract queries. Mirrors `FALLBACK_SOURCE` in oracle-price.ts.
const READ_SOURCE_ADDRESS =
  "GAUVY7FNDKVWRMW3SYEMX6QMFSWQDKC6XIPJJKAMOEMLZPAI7XZPDV3D";

const WAD = BigInt("1000000000000000000"); // 1e18

// "USDC" is the canonical peg — legacy BLUSDC/AQUSDC/SOUSDC aliases collapse here.
const PRICEABLE_TOKENS = ["USDC", ...ACTIVE_ASSETS] as const;

// Maps the symbol stored on the smart account back to a canonical price key
// resolvable through the oracle cache.
const canonicalSymbol = (sym: string): string => {
  const u = sym.toUpperCase();
  if (
    u === "USDC" || u === "BLEND_USDC" || u === "BLUSDC" ||
    u === "AQUARIUS_USDC" || u === "AQUSDC" ||
    u === "SOROSWAP_USDC" || u === "SOUSDC"
  ) return "USDC";
  return u;
};

const wadToNumber = (raw: unknown): number => {
  if (raw === null || raw === undefined) return 0;
  try {
    const bi = BigInt((raw as { toString(): string }).toString());
    const whole = Number(bi / WAD);
    const frac = Number(bi % WAD) / 1e18;
    return whole + frac;
  } catch {
    return 0;
  }
};

// Stellar token balances use 7 decimal places (stroops), not 18-decimal WAD.
const SAC_DECIMALS = BigInt(10_000_000); // 1e7
const sacToNumber = (raw: unknown): number => {
  if (raw === null || raw === undefined) return 0;
  try {
    const bi = BigInt((raw as { toString(): string }).toString());
    const whole = Number(bi / SAC_DECIMALS);
    const frac = Number(bi % SAC_DECIMALS) / 1e7;
    return whole + frac;
  } catch {
    return 0;
  }
};

// SAC contracts for the two native assets held in margin accounts.
// Mirrors MARGIN_SAC_TOKENS in farmTrackingCollateral.ts.
const SAC_TOKEN_CONFIGS = [
  { contractId: CONTRACT_ADDRESSES.BLEND_XLM, symbol: "XLM" },
  { contractId: CONTRACT_ADDRESSES.USDC_TOKEN || CONTRACT_ADDRESSES.BLEND_USDC, symbol: "USDC" },
] as const;

/**
 * Read the live XLM and USDC SAC balances held by a margin smart account.
 * Returns a map of symbol → amount (human units). Mirrors the behaviour of
 * reconcileMarginRawSacCollateral in farmTrackingCollateral.ts so that the
 * protocol-wide scan uses the same gross-collateral formula as the connected-
 * wallet path.
 */
async function readSacBalances(
  server: StellarSdk.rpc.Server,
  smartAccount: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    SAC_TOKEN_CONFIGS.map(async ({ contractId, symbol }) => {
      const raw = await simulateView<unknown>(
        server,
        contractId,
        "balance",
        StellarSdk.nativeToScVal(smartAccount, { type: "address" }),
      );
      out.set(symbol, sacToNumber(raw));
    }),
  );
  return out;
}

let lastResult: { accounts: AccountSnapshot[]; ownerByAccount: Map<string, string>; fetchedAt: number } | null = null;
let inflight: Promise<{ accounts: AccountSnapshot[]; ownerByAccount: Map<string, string> }> | null = null;
const ALL_ACCOUNTS_TTL_MS = 30_000;

// Hard ceiling on how many open accounts we deep-scan in a single pass. The
// per-account read costs `2 + collateral_tokens + debt_tokens + farm` RPC
// calls, so without a cap the protocol-wide scan grows O(accounts × tokens)
// and will overwhelm RPC at mainnet scale. We keep the most recently
// registered accounts (the tail of SmartAccountsList, which `add_account`
// appends to) and log how many were omitted — never silently truncate.
// The permanent fix is a Mercury per-account table; this bound makes the
// RPC path safe until then.
const MAX_DEEP_SCAN_ACCOUNTS = 200;

// Cap simultaneous in-flight RPC requests. The previous code fanned out every
// account (and every token within it) through one unbounded `Promise.all`,
// firing hundreds of concurrent `simulateTransaction` calls. Pooling keeps
// RPC pressure flat regardless of roster size.
const SCAN_CONCURRENCY = 8;

/** Run `fn` over `items` with at most `limit` promises in flight at once. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Read RegistryKey::SmartAccountsList from persistent storage. Returns
 *  every smart account address ever registered (open + closed). Use
 *  {@link readSmartAccountOwner} to filter the closed ones out. */
async function readAllSmartAccounts(
  server: StellarSdk.rpc.Server,
): Promise<string[]> {
  // `#[contracttype] enum` unit variants serialize as a 1-element ScVec
  // containing just the variant Symbol — same convention the SDK uses
  // when reading existing tuple variants like SmartAccounts(Address).
  const key = StellarSdk.xdr.ScVal.scvVec([
    StellarSdk.xdr.ScVal.scvSymbol("SmartAccountsList"),
  ]);

  try {
    const entry = await server.getContractData(
      CONTRACT_ADDRESSES.REGISTRY,
      key,
      StellarSdk.rpc.Durability.Persistent,
    );
    const native = StellarSdk.scValToNative(entry.val.contractData().val());
    return Array.isArray(native) ? (native as string[]) : [];
  } catch (err: any) {
    const msg = String(err?.message ?? err ?? "");
    // Empty registry on a freshly redeployed Registry — treat as no accounts.
    if (msg.includes("not found") || msg.includes("Could not find ledger entry")) {
      return [];
    }
    console.warn("[allMarginAccounts] readAllSmartAccounts failed:", err);
    return [];
  }
}

/** Read RegistryKey::OwnerAddress(account). Stored as Option<Address>:
 *   - `Some(trader)`  → account open, returns the trader G-address
 *   - `None::<Address>` → account was closed (sweep + deactivate)
 *   - missing entry   → never registered
 *  Returns `null` for the closed/missing cases so callers can skip them. */
async function readSmartAccountOwner(
  server: StellarSdk.rpc.Server,
  smartAccount: string,
): Promise<string | null> {
  const key = StellarSdk.xdr.ScVal.scvVec([
    StellarSdk.xdr.ScVal.scvSymbol("OwnerAddress"),
    StellarSdk.nativeToScVal(smartAccount, { type: "address" }),
  ]);

  try {
    const entry = await server.getContractData(
      CONTRACT_ADDRESSES.REGISTRY,
      key,
      StellarSdk.rpc.Durability.Persistent,
    );
    const native = StellarSdk.scValToNative(entry.val.contractData().val());
    if (native === null || native === undefined) return null;
    // Soroban's `Option<T>` decodes to either the inner value (Some) or
    // `null` (None). Trader addresses are G- (classic) or C- (contract) —
    // accept both so smart-wallet traders aren't dropped.
    if (typeof native === "string" && (native.startsWith("G") || native.startsWith("C"))) {
      return native;
    }
    return null;
  } catch {
    return null;
  }
}

/** Build a single Soroban view-call simulation against the given contract. */
async function simulateView<T = unknown>(
  server: StellarSdk.rpc.Server,
  contractAddr: string,
  method: string,
  ...args: StellarSdk.xdr.ScVal[]
): Promise<T | null> {
  try {
    const sourceAccount = await server.getAccount(READ_SOURCE_ADDRESS);
    const contract = new StellarSdk.Contract(contractAddr);
    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
      return null;
    }
    return StellarSdk.scValToNative(sim.result.retval) as T;
  } catch {
    return null;
  }
}

interface MarginAccountChainState {
  account: string;
  owner: string;
  collateralByToken: Map<string, number>; // token amount (human units)
  debtByToken: Map<string, number>;
  isActive: boolean;
}

/** Read every collateral token + balance and every borrowed token + debt
 *  for one smart account. Returns null when the account is closed (no
 *  active flag) so callers can skip it. */
async function readSingleAccountState(
  server: StellarSdk.rpc.Server,
  smartAccount: string,
  owner: string,
): Promise<MarginAccountChainState | null> {
  const isActive =
    (await simulateView<boolean>(server, smartAccount, "is_account_active")) ?? false;
  if (!isActive) {
    return {
      account: smartAccount,
      owner,
      collateralByToken: new Map(),
      debtByToken: new Map(),
      isActive: false,
    };
  }

  const [collateralTokens, borrowedTokens] = await Promise.all([
    simulateView<string[]>(server, smartAccount, "get_all_collateral_tokens"),
    simulateView<string[]>(server, smartAccount, "get_all_borrowed_tokens"),
  ]);

  const collateralByToken = new Map<string, number>();

  // Budget/latency fix: these four reads (per-token collateral balances,
  // farm/tracking collateral, raw SAC balances, per-token debt) don't depend
  // on each other's results, but were previously awaited one after another —
  // 4 sequential RPC round-trip GROUPS per account, multiplied across up to
  // MAX_DEEP_SCAN_ACCOUNTS accounts bounded by only SCAN_CONCURRENCY workers,
  // was the dominant cost behind the analytics page's slow cold load. Running
  // them concurrently cuts each account's own latency to roughly the
  // slowest single group instead of the sum of all four.
  const [, farmResult, sacResult, debtByToken] = await Promise.all([
    Array.isArray(collateralTokens)
      ? Promise.all(
          collateralTokens.map(async (sym) => {
            const balanceRaw = await simulateView<unknown>(
              server,
              smartAccount,
              "get_collateral_token_balance",
              StellarSdk.nativeToScVal(sym, { type: "symbol" }),
            );
            const amount = wadToNumber(balanceRaw);
            if (amount > 0) collateralByToken.set(canonicalSymbol(sym), amount);
          }),
        )
      : Promise.resolve(),

    // Farm / tracking-token collateral (Blend b-tokens, Aquarius & Soroswap LP) —
    // same sources as the Farm page; smart-account WAD balances are often zero for these symbols.
    fetchFarmTrackingCollateralAmountMap(smartAccount).catch((e) => {
      console.warn(`[allMarginAccounts] farm collateral merge failed for ${smartAccount}:`, e);
      return null;
    }),

    // Raw SAC balances (XLM/BLUSDC) — authoritative for the raw assets
    // physically held in the account (including borrowed cash that sits as
    // native tokens before being deployed). Mirrors
    // reconcileMarginRawSacCollateral in farmTrackingCollateral.ts so the HF
    // formula matches the connected-wallet path.
    readSacBalances(server, smartAccount).catch((e) => {
      console.warn(`[allMarginAccounts] SAC balance read failed for ${smartAccount}:`, e);
      return null;
    }),

    (async () => {
      const debtByTokenInner = new Map<string, number>();
      if (Array.isArray(borrowedTokens)) {
        await Promise.all(
          borrowedTokens.map(async (sym) => {
            // get_borrowed_token_debt routes to the live lending pool, so it
            // returns up-to-date principal+interest in WAD precision.
            const debtRaw = await simulateView<unknown>(
              server,
              smartAccount,
              "get_borrowed_token_debt",
              StellarSdk.nativeToScVal(sym, { type: "symbol" }),
            );
            const amount = wadToNumber(debtRaw);
            if (amount > 0) debtByTokenInner.set(canonicalSymbol(sym), amount);
          }),
        );
      }
      return debtByTokenInner;
    })(),
  ]);

  // Farm/tracking collateral merges in first, then raw SAC balances OVERWRITE
  // XLM/BLUSDC (authoritative, per the comment above) — same precedence as
  // the original sequential version, just applied after both reads land.
  if (farmResult) {
    farmResult.forEach((amt, sym) => {
      if (amt > 0) collateralByToken.set(sym, amt);
    });
  }
  if (sacResult) {
    sacResult.forEach((amt, sym) => {
      collateralByToken.set(sym, amt);
    });
  }

  return {
    account: smartAccount,
    owner,
    collateralByToken,
    debtByToken,
    isActive: true,
  };
}

function buildSnapshotFromState(state: MarginAccountChainState): AccountSnapshot {
  const collateral: CollateralPosition[] = [];
  let totalCollateralUsd = 0;
  state.collateralByToken.forEach((amount, symbol) => {
    const price = getCachedTokenPrice(symbol);
    const usd = amount * price;
    totalCollateralUsd += usd;
    collateral.push({
      asset: symbol,
      symbol,
      decimals: 7,
      amount,
      usd,
      type: collateralPositionTypeForSymbol(symbol),
    });
  });

  const debt: DebtPosition[] = [];
  let totalDebtUsd = 0;
  state.debtByToken.forEach((amount, symbol) => {
    const price = getCachedTokenPrice(symbol);
    const usd = amount * price;
    totalDebtUsd += usd;
    debt.push({ asset: symbol, symbol, decimals: 7, amount, usd });
  });

  // SAC balances (XLM/BLUSDC) are now authoritative in collateralByToken — they
  // were overwritten by readSacBalances() in readSingleAccountState, which mirrors
  // reconcileMarginRawSacCollateral. This means totalCollateralUsd already includes:
  //   • tracking-token collateral (bTokens, LP shares) from fetchFarmTrackingCollateralAmountMap
  //   • raw borrowed cash sitting as native tokens (from SAC balance reads)
  // No approximation needed; always use totalCollateralUsd directly.
  const grossCollateralUsd = totalCollateralUsd;

  const healthFactor = totalDebtUsd > 0
    ? grossCollateralUsd / totalDebtUsd
    : Number.POSITIVE_INFINITY;
  const leverage = totalCollateralUsd > 0
    ? 1 + totalDebtUsd / totalCollateralUsd
    : 1;

  return {
    account: state.account,
    ownerProxy: state.owner,
    chainId: STELLAR_CHAIN_ID,
    collateral,
    debt,
    totalCollateralUsd: grossCollateralUsd,
    totalDebtUsd,
    healthFactor,
    leverage,
    isHealthy: healthFactor >= 1.1,
  };
}

/**
 * Top-level reader for the analytics dashboard. Pulls the full smart-account
 * roster from the Registry, snapshots each open account, and rolls them up
 * into the `AccountSnapshot[]` shape consumed by every `derive*` helper.
 *
 * Load is bounded two ways: at most {@link SCAN_CONCURRENCY} RPC requests are
 * in flight at once (a pool, not an unbounded `Promise.all`), and the deep
 * per-account scan is capped at {@link MAX_DEEP_SCAN_ACCOUNTS} (most-recent
 * accounts kept, overflow logged). Together these keep RPC pressure flat
 * regardless of how large the account roster grows.
 */
export async function fetchAllMarginAccountSnapshots(opts?: {
  force?: boolean;
}): Promise<{
  accounts: AccountSnapshot[];
  ownerByAccount: Map<string, string>;
}> {
  const force = opts?.force ?? false;
  const now = Date.now();

  if (!force && lastResult && now - lastResult.fetchedAt < ALL_ACCOUNTS_TTL_MS) {
    return { accounts: lastResult.accounts, ownerByAccount: lastResult.ownerByAccount };
  }
  if (inflight) return inflight;

  const run = (async () => {
    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

    // Warm the price cache before we start computing USD totals so every
    // snapshot uses the same oracle prices instead of static fallbacks on
    // the first call.
    await fetchTokenPrices([...PRICEABLE_TOKENS]).catch(() => undefined);

    const allSmartAccounts = await readAllSmartAccounts(server);
    if (allSmartAccounts.length === 0) {
      return { accounts: [] as AccountSnapshot[], ownerByAccount: new Map<string, string>() };
    }

    // Resolve owners + filter closed accounts, pooled to keep RPC pressure flat.
    const ownerResults = await mapWithConcurrency(
      allSmartAccounts,
      SCAN_CONCURRENCY,
      async (account) => ({ account, owner: await readSmartAccountOwner(server, account) }),
    );
    const openPairs = ownerResults.filter(
      (p): p is { account: string; owner: string } => Boolean(p.owner),
    );

    // Cap the expensive deep-scan. Keep the most recently registered accounts
    // (tail of the append-only SmartAccountsList) and log the omission.
    let scanPairs = openPairs;
    if (openPairs.length > MAX_DEEP_SCAN_ACCOUNTS) {
      const omitted = openPairs.length - MAX_DEEP_SCAN_ACCOUNTS;
      scanPairs = openPairs.slice(-MAX_DEEP_SCAN_ACCOUNTS);
      console.warn(
        `[allMarginAccounts] ${openPairs.length} open accounts exceed the ` +
          `${MAX_DEEP_SCAN_ACCOUNTS} deep-scan cap — snapshotting the ${MAX_DEEP_SCAN_ACCOUNTS} ` +
          `most recent, omitting ${omitted}. (Move to a Mercury per-account table to lift this.)`,
      );
    }

    const stateResults = await mapWithConcurrency(
      scanPairs,
      SCAN_CONCURRENCY,
      ({ account, owner }) =>
        readSingleAccountState(server, account, owner).catch((err) => {
          console.warn(`[allMarginAccounts] state read failed for ${account}:`, err);
          return null;
        }),
    );

    const ownerByAccount = new Map<string, string>();
    const snapshots: AccountSnapshot[] = [];
    for (const state of stateResults) {
      if (!state || !state.isActive) continue;
      ownerByAccount.set(state.account, state.owner);
      snapshots.push(buildSnapshotFromState(state));
    }

    return { accounts: snapshots, ownerByAccount };
  })();

  inflight = run;
  try {
    const result = await run;
    lastResult = { ...result, fetchedAt: Date.now() };
    return result;
  } finally {
    inflight = null;
  }
}

/** Drop the in-memory cache so the next call re-reads from RPC. Useful from
 *  hot-paths after an account has been opened/closed in the same session. */
export function invalidateAllMarginAccountsCache(): void {
  lastResult = null;
}
