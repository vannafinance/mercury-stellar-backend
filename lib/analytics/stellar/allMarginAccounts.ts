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

const STELLAR_CHAIN_ID = 0;

// Public, funded testnet G-account used purely as the simulation source for
// read-only contract queries. Mirrors `FALLBACK_SOURCE` in oracle-price.ts.
const READ_SOURCE_ADDRESS =
  "GAUVY7FNDKVWRMW3SYEMX6QMFSWQDKC6XIPJJKAMOEMLZPAI7XZPDV3D";

const WAD = BigInt("1000000000000000000"); // 1e18

const PRICEABLE_TOKENS = ["XLM", "USDC", "BLUSDC", "AQUSDC", "SOUSDC"] as const;

// Maps the symbol stored on the smart account back to a canonical price key
// resolvable through the oracle cache (which already aliases BLUSDC→USDC etc).
const canonicalSymbol = (sym: string): string => {
  const u = sym.toUpperCase();
  if (u === "USDC" || u === "BLEND_USDC") return "BLUSDC";
  if (u === "AQUARIUS_USDC") return "AQUSDC";
  if (u === "SOROSWAP_USDC") return "SOUSDC";
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

let lastResult: { accounts: AccountSnapshot[]; ownerByAccount: Map<string, string>; fetchedAt: number } | null = null;
let inflight: Promise<{ accounts: AccountSnapshot[]; ownerByAccount: Map<string, string> }> | null = null;
const ALL_ACCOUNTS_TTL_MS = 30_000;

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
  if (Array.isArray(collateralTokens)) {
    await Promise.all(
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
    );
  }

  // Farm / tracking-token collateral (Blend b-tokens, Aquarius & Soroswap LP) —
  // same sources as the Farm page; smart-account WAD balances are often zero for these symbols.
  try {
    const farmAmounts = await fetchFarmTrackingCollateralAmountMap(smartAccount);
    farmAmounts.forEach((amt, sym) => {
      if (amt > 0) collateralByToken.set(sym, amt);
    });
  } catch (e) {
    console.warn(`[allMarginAccounts] farm collateral merge failed for ${smartAccount}:`, e);
  }

  const debtByToken = new Map<string, number>();
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
        if (amount > 0) debtByToken.set(canonicalSymbol(sym), amount);
      }),
    );
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

  // Mirrors the contract-time HF check used in the connected-wallet flow
  // (see margin-account-info-store.refreshBorrowedBalances) — borrowed funds
  // physically live in the smart account until they're deployed elsewhere,
  // so we add them back to the collateral leg unless tracking-token
  // collateral is already present (which would double-count).
  const hasTrackingTokenCollateral = collateral.some(
    (c) => c.type === "aToken" || c.type === "lp" || c.type === "track",
  );
  const grossCollateralUsd = hasTrackingTokenCollateral
    ? totalCollateralUsd
    : totalCollateralUsd + totalDebtUsd;

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
 * Concurrency: `getContractData` calls and per-account view-call fan-outs
 * run in parallel (Promise.all). For a deployment with N margin accounts
 * the total RPC count is roughly:
 *     1 (list)  +  N (owner)  +  N (active)  +  N×(2 + col_tokens + debt_tokens)
 * which is fine for the testnet's typical few-dozen-account scale.
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

    // Resolve owners + filter closed accounts in parallel.
    const ownerResults = await Promise.all(
      allSmartAccounts.map(async (account) => ({
        account,
        owner: await readSmartAccountOwner(server, account),
      })),
    );
    const openPairs = ownerResults.filter(
      (p): p is { account: string; owner: string } => Boolean(p.owner),
    );

    const stateResults = await Promise.all(
      openPairs.map(({ account, owner }) =>
        readSingleAccountState(server, account, owner)
          .catch((err) => {
            console.warn(`[allMarginAccounts] state read failed for ${account}:`, err);
            return null;
          }),
      ),
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
