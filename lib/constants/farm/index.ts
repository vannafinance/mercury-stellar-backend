export const farmTableHeadings = [
  { label: "Pool", id: "pool", icon: true },
  { label: "DEX", id: "dex", icon: true },
  { label: "DEX LP TVL", id: "dex-lp-tvl", icon: true },
  { label: "Vanna TVL", id: "vanna-tvl", icon: true },
  { label: "Pool APR", id: "pool-apr", icon: true },
  { label: "Leveraged APR", id: "leveraged-apr", icon: true },
  { label: "1D VOL", id: "1d-vol", icon: true },
  { label: "30 D VOL", id: "30d-vol", icon: true },
  { label: "1D VOL/TVL", id: "1d-vol-tvl", icon: true },
];

export const farmTableBody = {
  rows: [
    // Row 0: Soroswap AMM, XLM/USDC on Stellar (Testnet)
    {
      cell: [
        {
          chain: "XLM",
          titles: ["XLM", "USDC"],
          tags: ["Soroswap", "0.30%", "Testnet"],
        },
        {
          title: "Soroswap",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
      ],
    },
    // Row 1: Aquarius AMM, XLM/USDC on Stellar (Testnet)
    {
      cell: [
        {
          chain: "XLM",
          titles: ["XLM", "USDC"],
          tags: ["Aquarius", "0.30%", "Testnet"],
        },
        {
          title: "Aquarius",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
      ],
    },
    // Row 1: V3 Protocol, 9summits Curator, Kraken Provider, ETH Chain
    {
      cell: [
        {
          chain: "ETH",
          titles: ["USDT", "BNB"],
          tags: ["V3", "0.30%", "9summits", "Kraken"],
        },
        {
          title: "Pancake",
        },
        {
          title: "$100M",
        },
        {
          title: "$80M",
        },
        {
          title: "5.42%",
        },
        {
          title: "12.8%",
        },
        {
          title: "$30.4k",
        },
        {
          title: "$701.7k",
        },
        {
          title: "0.43",
        },
      ],
    },
    // Row 2: V2 Protocol, 9summits Curator, Binance Provider, USDC Chain
    {
      cell: [
        {
          chain: "USDC",
          titles: ["ETH", "USDC"],
          tags: ["V2", "0.50%", "9summits", "Binance"],
        },
        {
          title: "Uniswap",
        },
        {
          title: "$85M",
        },
        {
          title: "$65M",
        },
        {
          title: "3.21%",
        },
        {
          title: "8.5%",
        },
        {
          title: "$25.8k",
        },
        {
          title: "$580.2k",
        },
        {
          title: "0.30",
        },
      ],
    },
    // Row 3: V3 Protocol, Coinbase Provider (only 3 tags), USDT Chain
    {
      cell: [
        {
          chain: "USDT",
          titles: ["USDC", "USDT"],
          tags: ["V3", "0.25%", "Coinbase"],
        },
        {
          title: "SushiSwap",
        },
        {
          title: "$120M",
        },
        {
          title: "$95M",
        },
        {
          title: "6.15%",
        },
        {
          title: "15.2%",
        },
        {
          title: "$42.1k",
        },
        {
          title: "$892.5k",
        },
        {
          title: "0.35",
        },
      ],
    },
    // Row 4: V2 Protocol, Lido Curator, Kraken Provider, ETH Chain
    {
      cell: [
        {
          chain: "ETH",
          titles: ["wstHYPE", "HYPE"],
          tags: ["V2", "0.20%", "Lido", "Kraken"],
        },
        {
          title: "Curve",
        },
        {
          title: "$200M",
        },
        {
          title: "$150M",
        },
        {
          title: "4.75%",
        },
        {
          title: "10.3%",
        },
        {
          title: "$55.3k",
        },
        {
          title: "$1.2M",
        },
        {
          title: "0.28",
        },
      ],
    },
    // Row 5: V3 Protocol, 9summits Curator, Binance Provider, USDC Chain
    {
      cell: [
        {
          chain: "USDC",
          titles: ["kHYPE", "USDe"],
          tags: ["V3", "0.35%", "9summits", "Binance"],
        },
        {
          title: "Balancer",
        },
        {
          title: "$75M",
        },
        {
          title: "$60M",
        },
        {
          title: "7.28%",
        },
        {
          title: "18.5%",
        },
        {
          title: "$18.9k",
        },
        {
          title: "$420.8k",
        },
        {
          title: "0.25",
        },
      ],
    },
    // Row 6: V2 Protocol, Compound Curator, Coinbase Provider, USDT Chain
    {
      cell: [
        {
          chain: "USDT",
          titles: ["wHYPE", "USDC"],
          tags: ["V2", "0.45%", "Compound", "Coinbase"],
        },
        {
          title: "Pancake",
        },
        {
          title: "$90M",
        },
        {
          title: "$70M",
        },
        {
          title: "2.95%",
        },
        {
          title: "7.8%",
        },
        {
          title: "$28.5k",
        },
        {
          title: "$640.3k",
        },
        {
          title: "0.32",
        },
      ],
    },
    // Row 7: V3 Protocol, Kraken Provider (only 3 tags), ETH Chain
    {
      cell: [
        {
          chain: "ETH",
          titles: ["USDTO", "BNB"],
          tags: ["V3", "0.15%", "Kraken"],
        },
        {
          title: "Uniswap",
        },
        {
          title: "$110M",
        },
        {
          title: "$88M",
        },
        {
          title: "5.80%",
        },
        {
          title: "13.5%",
        },
        {
          title: "$35.7k",
        },
        {
          title: "$755.2k",
        },
        {
          title: "0.32",
        },
      ],
    },
    // Row 8: V2 Protocol, Lido Curator, Binance Provider, USDC Chain
    {
      cell: [
        {
          chain: "USDC",
          titles: ["USDT", "ETH"],
          tags: ["V2", "0.40%", "Lido", "Binance"],
        },
        {
          title: "Curve",
        },
        {
          title: "$95M",
        },
        {
          title: "$72M",
        },
        {
          title: "4.12%",
        },
        {
          title: "9.7%",
        },
        {
          title: "$31.2k",
        },
        {
          title: "$680.5k",
        },
        {
          title: "0.33",
        },
      ],
    },
  ],
};

// Single Asset Table Data
export const singleAssetTableHeadings = [
  { label: "Asset", id: "asset", icon: true },
  { label: "Protocol", id: "protocol", icon: true },
  { label: "Total Deposits", id: "total-deposits", icon: true },
  { label: "Provider TVL", id: "provider-tvl", icon: true },
  { label: "Supply APY", id: "supply-apy", icon: true },
  { label: "Leveraged APY", id: "leveraged-apy", icon: true },
  { label: "24H Volume", id: "24h-volume", icon: true },
  { label: "Utilization", id: "utilization", icon: true },
];

// Blend Capital uses a SINGLE pool contract for all assets.
// The pool address is CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF (TestnetV2).
// The asset to deposit/withdraw is specified via the `tokens_out` field in ExternalProtocolCall.
export const BLEND_POOL_ASSETS_CONFIG = [
  { symbol: "XLM", iconPath: "/coins/xlmbg.png" },
  { symbol: "USDC", iconPath: "/icons/usdc-icon.svg" },
];

export const singleAssetTableBody = {
  rows: [
    // Row 1: XLM - Blend Supply Pool
    {
      cell: [
        {
          chain: "XLM",
          title: "XLM",
          tags: ["Blend", "Supply"],
        },
        {
          title: "Blend",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
      ],
    },
    // Row 2: USDC - Blend Supply Pool
    {
      cell: [
        {
          chain: "USDC",
          title: "USDC",
          tags: ["Blend", "Supply"],
        },
        {
          title: "Blend",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
        {
          title: "—",
        },
      ],
    },
  ],
};


export const FARM_STATS_ITEMS = [
  {
    id: "depositTVL",
    name: "Your Deposit TVL",
    icon: "/margin/bag.png",
  },
  {
    id: "earnings",
    name: "Your Earnings",
    icon: "/margin/dollar.png",
  },
  {
    id: "netFarmApy",
    name: "Net Farm APY",
    icon: "/margin/health.png",
  },
  {
    id: "pendingRewards",
    name: "Pending Rewards",
    icon: "/margin/retry.png",
  },
];

export const FARM_STATS_VALUES: Record<string, string | number | null> = {
  depositTVL: "$2000",
  earnings: "$1000",
  netFarmApy: "—",
  pendingRewards: "—",
};



export const MARGIN_ACCOUNT_STATS_ITEMS = [
  {
    id: "totalCollateral",
    name: "Total Collateral",
    icon: "/icons/bnb-icon.png",
  },
  {
    id: "availableCollateral",
    name: "Available Collateral",
    icon: "/icons/bnb-icon.png",
  },
  {
    id: "borrowedAssets",
    name: "Borrowed Assets",
    icon: "/icons/bnb-icon.png",
  },
  {
    id: "crossAccountLeverage",
    name: "Cross Account Leverage",
    icon: "/icons/bnb-icon.png",
  },
  {
    id: "healthFactor",
    name: "Health Factor",
    icon: "/icons/bnb-icon.png",
  },
  {
    id: "pnl",
    name: "PNL",
    icon: "/icons/bnb-icon.png",
  },
  {
    id: "crossMarginRatio",
    name: "Cross Margin Ratio",
    icon: "/icons/bnb-icon.png",
  },
];


export const MARGIN_ACCOUNT_STATS_VALUES: Record<
  string,
  string | number | null
> = {
  totalCollateral: "$3000",
  availableCollateral: null, // shows "–"
  borrowedAssets: "200k USD",
  crossAccountLeverage: null,
  healthFactor: null,
  pnl: null,
  crossMarginRatio: null,
};

export const LEVERAGE_HEALTH_STATS_ITEMS = [
  {
    id: "maxLeverage",
    name: "Max Utilised Leverage / Max Available Leverage",
    amount: "7x / 10x",
  },
  {
    id: "positionHealthFactor",
    name: "Position Health Factor",
    amount: "N/A",
  },
  {
    id: "marginHealthFactor",
    name: "Margin Health Factor",
    amount: "N/A",
  },
  {
    id: "avgLiquidationTime",
    name: "Avg Liquidation Time",
    amount: "N/A",
  },
];

export const farmStatsData = [
  { heading: "Total Value Locked", value: "$342.8M", uptrend: "+12.4%" },
  { heading: "24H Trading Volume", value: "$8.2M", uptrend: "+5.8%" },
  { heading: "Pool APR", value: "24.31%", uptrend: "+2.1%" },
  { heading: "Leveraged APR", value: "58.7%", uptrend: "+4.6%" },
];

export const farmLiquidationStatsData = [
  { heading: "Position Health Factor", value: "1.82" },
  { heading: "Liquidation Price", value: "$1,842.50", downtrend: "-8.2%" },
  { heading: "Current Leverage", value: "2.4x" },
  { heading: "Max Available Leverage", value: "10x" },
  { heading: "Estimated Daily Yield", value: "$34.12", uptrend: "+2.3%" },
];
