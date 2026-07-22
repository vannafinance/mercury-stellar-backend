'use client';

/**
 * "Activity" tab for an earn pool: shows the pool's distribution and a merged
 * transaction feed. On-chain transactions (from the indexer) are de-duplicated
 * against locally-recorded history by tx hash so a just-submitted action shows
 * immediately and isn't double-listed once it lands on-chain.
 */
import { useMemo } from "react";
import { Table } from "./table";
import { useTheme } from "@/contexts/theme-context";
import { useTokenPrices } from "@/contexts/price-context";
import { usePoolData, useEarnTransactions } from "@/hooks/use-earn";
import { useSelectedPoolStore } from "@/store/selected-pool-store";
import { useUserStore } from "@/store/user";
import { iconPaths } from "@/lib/constants";
import { getEarnHistoryByAsset } from "@/lib/earn-history";
import { useTokenPrices as useTokenPricesFromHook } from "@/hooks/use-token-prices";

type EarnTx = {
  type: 'supply' | 'withdraw';
  asset: string;
  amount: string;
  timestamp: number;
  hash: string;
  status?: 'success' | 'pending' | 'failed';
};

const distributionHeadings = [
  { label: "User Id", id: "user-id" },
  { label: "Supplied Assets", id: "supplied-assets" },
  { label: "Supply (%)", id: "supply-percent" },
];

/** Empty, mutable table-body scaffold for transaction rows; populated per-render. */
export const transactionTableBody = {
  rows: [] as {
    cell: {
      title?: string;
      description?: string;
      badge?: string;
      icon?: string;
      clickable?: string;
      link?: string;
      percentage?: number;
    }[];
  }[],
};

/** Column definitions for the recent-transactions table (shared with other earn views). */
export const transactionTableHeadings = [
  { label: "Date", id: "date" },
  { label: "Type", id: "type" },
  { label: "Amount", id: "amount" },
  { label: "Status", id: "status" },
  { label: "Tx Hash", id: "txHash" },
];

// Map internal asset key → display symbol
const DISPLAY_SYMBOL: Record<string, string> = {
  XLM: "XLM",
  USDC: "BLUSDC",
  AQUARIUS_USDC: "AqUSDC",
  SOROSWAP_USDC: "SoUSDC",
};

const toInternalAsset = (value: string): string => {
  if (value === "AqUSDC" || value === "AQUARIUS_USDC") return "AQUARIUS_USDC";
  if (value === "SoUSDC" || value === "SOROSWAP_USDC") return "SOROSWAP_USDC";
  if (value === "BLEND_USDC") return "USDC";
  if (value === "BLUSDC") return "USDC";
  return value.toUpperCase();
};

// Aquarius / Soroswap USDC variants share USDC's oracle price (no separate
// Reflector entry exists). The hook resolves the alias internally.
const PRICE_TOKEN_FOR_ASSET: Record<string, string> = {
  XLM: 'XLM',
  USDC: 'USDC',
  AQUARIUS_USDC: 'USDC',
  SOROSWAP_USDC: 'USDC',
  BLND: 'BLND',
  AQUA: 'AQUA',
  WETH: 'WETH',
  EURC: 'EURC',
};

const normalizeTimestamp = (value: number | string | undefined): number => {
  const ts = Number(value ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts < 1_000_000_000_000 ? ts * 1000 : ts;
};

/**
 * Renders pool distribution + a merged (on-chain ∪ local) transaction table for
 * the currently selected pool, with USD values derived from oracle prices.
 */
export const ActivityTab = () => {
  const { isDark } = useTheme();
  const { getPrice } = useTokenPrices();
  const { transactions: recentTransactions } = useEarnTransactions();
  const walletAddress = useUserStore((state) => state.address);
  const { pools } = usePoolData();
  const selectedAsset = useSelectedPoolStore((state) => state.selectedAsset);
  const assetKey = toInternalAsset(selectedAsset);
  const displaySymbol = DISPLAY_SYMBOL[assetKey] ?? assetKey;
  const tokenPrices = useTokenPricesFromHook(['XLM', 'USDC']);
  const priceForAsset = (key: string): number =>
    tokenPrices[PRICE_TOKEN_FOR_ASSET[key] ?? key] ?? 1;

  const filteredTransactions = useMemo(() => {
    const normalizeAsset = (value: string) => toInternalAsset(value || "");

    const onchain = (recentTransactions ?? [])
      .filter((tx: EarnTx) => normalizeAsset(tx.asset) === assetKey)
      .map((tx: EarnTx) => ({
        type: tx.type === "withdraw" ? "withdraw" : "supply",
        asset: assetKey,
        amount: String(tx.amount ?? "0"),
        timestamp: normalizeTimestamp(tx.timestamp),
        hash: String(tx.hash ?? ""),
        status: tx.status ?? "success",
      }));

    const onchainHashes = new Set(onchain.map((tx) => tx.hash).filter(Boolean));
    const local = getEarnHistoryByAsset(assetKey, walletAddress)
      .filter((tx) => !tx.hash || !onchainHashes.has(tx.hash))
      .map((tx) => ({
        type: tx.type,
        asset: assetKey,
        amount: tx.amount,
        timestamp: normalizeTimestamp(tx.timestamp),
        hash: tx.hash,
        status: tx.status,
      }));

    return [...onchain, ...local].sort((a, b) => b.timestamp - a.timestamp);
  }, [recentTransactions, assetKey, walletAddress]);

  // Pool distribution for the currently viewed pool
  const userDistributionBody = useMemo(() => {
    const pool = pools[assetKey as keyof typeof pools];
    const totalSupply = parseFloat(pool?.totalSupply || '0');
    const price = priceForAsset(assetKey);
    const usdValue = totalSupply * price;

    return {
      rows: [
        {
          cell: [
            {
              icon: iconPaths[displaySymbol] || "/icons/usdc-icon.svg",
              title: `${displaySymbol} Pool`,
              clickable: "address",
            },
            {
              icon: iconPaths[displaySymbol] || "/icons/usdc-icon.svg",
              title: `${totalSupply.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${displaySymbol}`,
              description: `$${usdValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            },
            { percentage: 100 },
          ],
        },
      ],
    };
  }, [pools, assetKey, displaySymbol, tokenPrices]);

  // Format transactions for table
  const txTableBody = useMemo(() => {
    if (filteredTransactions.length === 0) {
      return {
        rows: [
          {
            cell: [
              { title: "-", description: "No transactions yet" },
              { title: "-" },
              { title: "-" },
              { title: "-" },
              { title: "-" },
            ],
          },
        ],
      };
    }

    return {
      rows: filteredTransactions.map((tx) => ({
        cell: [
          {
            title: new Date(tx.timestamp).toLocaleDateString(),
            description: new Date(tx.timestamp).toLocaleTimeString(),
          },
          {
            title: tx.type === 'supply' ? 'Pool Deposit' : 'Pool Withdraw',
            badge: tx.type === 'supply' ? 'green' : 'orange',
          },
          {
            icon: iconPaths[DISPLAY_SYMBOL[assetKey] ?? assetKey] || iconPaths[assetKey] || `/icons/usdc-icon.svg`,
            title: `${(parseFloat(tx.amount) || 0).toFixed(2)} ${DISPLAY_SYMBOL[assetKey] ?? assetKey}`,
            description: `$${(parseFloat(tx.amount) * priceForAsset(assetKey)).toFixed(2)}`,
          },
          {
            title: tx.status ?? 'success',
            badge: (tx.status ?? 'success') === 'success' ? 'green' : (tx.status ?? 'success') === 'pending' ? 'yellow' : 'red',
          },
          {
            title: tx.hash ? `${tx.hash.slice(0, 8)}...${tx.hash.slice(-4)}` : "—",
            clickable: tx.hash ? "link" : undefined,
            link: tx.hash ? `https://stellar.expert/explorer/testnet/tx/${tx.hash}` : undefined,
          },
        ],
      })),
    };
  }, [filteredTransactions, assetKey, tokenPrices]);

  return (
    <section
      className={`w-full h-fit rounded-[20px] border-[1px] p-[24px] flex flex-col gap-[24px] ${
        isDark ? "bg-[#111111] border-[#333333]" : "bg-[#F7F7F7] border-gray-200"
      }`}
      aria-label="Activity Overview"
    >
      {/* Pool Distribution */}
      <article aria-label="Pool Distribution">
        <Table
          showPieChart={true}
          tableBodyBackground={isDark ? "bg-[#222222]" : "bg-white"}
          heading={{ heading: "Pool Distribution" }}
          tableHeadings={distributionHeadings}
          tableBody={userDistributionBody}
        />
      </article>

      {/* Recent Transactions */}
      <article aria-label="Recent Transactions">
        <div className="flex justify-between items-center mb-4">
          <h3 className={`text-lg font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
            Recent Transactions
          </h3>
          <span className={`text-sm ${isDark ? "text-gray-400" : "text-gray-500"}`}>
            {filteredTransactions.length} transactions
          </span>
        </div>
        <Table
          filterDropdownPosition="right"
          tableBodyBackground={isDark ? "bg-[#222222]" : "bg-white"}
          heading={{ heading: "" }}
          filters={{ filters: ["Deposits", "Withdrawals"], customizeDropdown: true }}
          tableHeadings={transactionTableHeadings}
          tableBody={txTableBody}
        />
      </article>

      {/* Stellar Explorer Link */}
      <div className={`text-center py-4 rounded-xl ${isDark ? "bg-[#1a1a1a]" : "bg-gray-100"}`}>
        <a
          href="https://stellar.expert/explorer/testnet"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#703AE6] hover:underline text-sm font-medium"
        >
          View all transactions on Stellar Expert →
        </a>
      </div>
    </section>
  );
};
