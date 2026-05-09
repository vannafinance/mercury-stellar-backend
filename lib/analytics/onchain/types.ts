// Types lifted out of the deleted fetchAllAccounts.ts (EVM-only). Kept here
// so derivations.ts and the Stellar adapter share one definition. The
// `account`/`ownerProxy` fields are plain strings (Stellar `C…`/`G…` addrs
// don't fit the `0x${string}` template the EVM types used).

export type CollateralPosition = {
  asset: string;
  symbol: string;
  decimals: number;
  amount: number;
  usd: number;
  type: "cash" | "aToken" | "lp" | "track" | "unknown";
};

export type DebtPosition = {
  asset: string;
  symbol: string;
  decimals: number;
  amount: number;
  usd: number;
};

export type AccountSnapshot = {
  account: string;
  ownerProxy: string;
  chainId: number;
  collateral: CollateralPosition[];
  debt: DebtPosition[];
  totalCollateralUsd: number;
  totalDebtUsd: number;
  healthFactor: number;
  leverage: number;
  isHealthy: boolean;
};

export type AllAccountsResult = {
  chainId: number;
  accounts: AccountSnapshot[];
  fetchedAt: number;
  accountCount: number;
  /** Snapshots from the connected wallet's margin account (0 if none). */
  realAccountCount: number;
  skippedCount: number;
};
