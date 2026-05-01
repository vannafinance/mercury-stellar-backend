// Margin component constants

// ============================================
// Positions Table Constants
// ============================================
export const TABLE_ROW_HEADINGS = [
  "Collateral Deposited",
  "Borrowed Assets",
  "Leverage Taken",
  "Interest accrued till date",
  "Action",
] as const;

export const COIN_ICONS: Record<string, string> = {
  // Legacy ETH test tokens
  "0xETH": "/icons/eth-icon.png",
  "0xUSDC": "/icons/usdc-icon.svg",
  "0xUSDT": "/icons/usdt-icon.svg",
  // Stellar / Soroban tokens
  XLM: "/coins/xlmbg.png",
  BLUSDC: "/icons/usdc-icon.svg",
  AQUSDC: "/icons/usdc-icon.svg",
  SOUSDC: "/icons/usdc-icon.svg",
  USDC: "/icons/usdc-icon.svg",
  EURC: "/icons/usdc-icon.svg",
};

// ============================================
// Collateral Box Constants
// ============================================
export const DEPOSIT_PERCENTAGES = [10, 25, 50, 100] as const;

export const PERCENTAGE_COLORS: Record<number, string> = {
  10: "bg-[#703AE6]",
  25: "bg-[#FC5457]",
  50: "bg-[#E63ABB]",
  100: "bg-[#FF007A]",
} as const;

// ============================================
// Leverage Collateral Constants
// ============================================
export const LEVERAGE_TABS = [
  {
    id: "leverage-assets",
    label: "Leverage your Assets",
    shortLabel: "Leverage",
  },
  {
    id: "repay-loan",
    label: "Repay Loan",
    shortLabel: "Repay",
  },
  {
    id: "transfer-collateral",
    label: "Transfer Collateral",
    shortLabel: "Transfer",
  },
] as const;

// ============================================
// Borrow Box Constants
// ============================================
export const MAX_LEVERAGE = 10;

export const MODE_CONFIG = {
  Deposit: {
    maxItems: 1,
    showTotal: false,
    showInputBoxes: false,
  },
  Borrow: {
    maxItems: 2,
    showTotal: true,
    showInputBoxes: true,
  },
} as const;

// ============================================
// Info Card Format Mapping
// Maps field IDs to format types for easy configuration
// Components handle currency/coin names themselves
// ============================================
import { FormatType } from "@/lib/utils/format-value";

export const FIELD_FORMAT_MAP: Record<string, FormatType> = {
  // Number values (components add currency names)
  totalBorrowedValue: "number",
  totalCollateralValue: "number",
  totalValue: "number",
  debtLimit: "number",
  minDebt: "number",
  maxDebt: "number",
  depositAmount: "number",
  fees: "number",
  totalDeposit: "number",
  updatedCollateral: "number",
  
  // Percentage values
  borrowRate: "percentage",
  liquidationPremium: "percentage",
  liquidationFee: "percentage",
  
  // Leverage and multipliers
  leverage: "leverage",
  platformPoints: "points",
  
  // Health factors
  avgHealthFactor: "health-factor",
  netHealthFactor: "health-factor",
  
  // Time values
  timeToLiquidation: "time-minutes",
} as const;

/**
 * Fields that should use large format (K/M) for numbers
 */
export const LARGE_FORMAT_FIELDS = [
  "totalBorrowedValue",
  "totalCollateralValue",
  "debtLimit",
  "minDebt",
  "maxDebt",
] as const;

// ============================================
// Account Stats Constants
// ============================================
export const ACCOUNT_STATS_ITEMS = [
  {
    id: "netHealthFactor",
    name: "Net Health Factor",
    icon: "/margin/health.png",
  },
  {
    id: "collateralLeftBeforeLiquidation",
    name: "Collateral Left Before Liquidation",
    icon: "/margin/liquidation.png",
  },
  {
    id: "netAvailableCollateral",
    name: "Net Available Collateral",
    icon: "/margin/dollar.png",
  },
  {
    id: "netAmountBorrowed",
    name: "Net amount Borrowed",
    icon: "/margin/retry.png",
  },
  {
    id: "netProfitAndLoss",
    name: "Net Profit & Loss",
    icon: "/margin/bag.png",
  },
] as const;

// ============================================
// Margin Account Info Constants
// ============================================
export const MARGIN_ACCOUNT_INFO_ITEMS = [
  {
    id: "totalBorrowedValue",
    name: "Total Borrowed value",
  },
  {
    id: "totalCollateralValue",
    name: "Total Collateral value",
  },
  {
    id: "totalValue",
    name: "Total Value",
  },
  {
    id: "avgHealthFactor",
    name: "Avg Health Factor",
  },
  {
    id: "timeToLiquidation",
    name: "Time to liquidation",
  },
  {
    id: "borrowRate",
    name: "Borrow Rate",
  },
] as const;

export const MARGIN_ACCOUNT_MORE_DETAILS_ITEMS = [
  {
    id: "liquidationPremium",
    name: "Liquidation premium",
  },
  {
    id: "liquidationFee",
    name: "Liquidation Fee",
  },
  {
    id: "debtLimit",
    name: "Debt Limit",
  },
  {
    id: "minDebt",
    name: "Min Debt",
  },
  {
    id: "maxDebt",
    name: "Max Debt",
  },
] as const;

// Items shown in the "ORACLES AND LTS" expandable section
export const MARGIN_ORACLE_LTS_ITEMS = [
  { id: "oracleContract", name: "Oracle Contract" },
  { id: "liquidationThreshold", name: "Liquidation Threshold" },
  { id: "riskEngine", name: "Risk Engine" },
] as const;

// ============================================
// Carousel Constants
// ============================================
export const CAROUSEL_ITEMS = [
  {
    icon: "/assets/mdi_learn-outline.png",
    title: "Multicollateral Loans",
    description:
      "Don't want to sell your ETH, LSTs, LRTs, and other bags? Borrow against them! You can add multiple colleterals at the same time and draw a loan from Gearbox. And then do whatever you want with that loan.",
  },
  {
    icon: "/assets/mdi_learn-outline.png",
    title: "Flexible Borrowing",
    description:
      "Access instant liquidity without selling your assets. Use your crypto holdings as collateral and maintain your long-term positions while getting the funds you need today.",
  },
  {
    icon: "/assets/mdi_learn-outline.png",
    title: "Maximize Capital",
    description:
      "Leverage your portfolio to its full potential. Borrow against multiple assets simultaneously and use the funds for trading, investing, or any other purpose you choose.",
  },
] as const;

// ============================================
// Position Constants
// ============================================
export const POSITION = [
  {
    positionId: 1,
    collateral: { asset: "0xUSDT", amount: "1000" }, // 100 USDT
    collateralUsdValue: 100,

    borrowed: [
      {
        assetData: { asset: "0xUSDC", amount: "1000" },
        percentage: 60,
        usdValue: 100,
      },
      {
        assetData: { asset: "0xETH", amount: "22000" }, // 0.022 ETH
        percentage: 40,
        usdValue: 403.67,
      },
    ],

    leverage: 5,
    interestAccrued: 30,
    isOpen: true,
    user: "0x123",
  },

  {
    positionId: 2,
    collateral: { asset: "0xUSDT", amount: "500" }, // 5000 USDT
    collateralUsdValue: 5000,

    borrowed: [
      {
        assetData: { asset: "0xUSDC", amount: "2000" }, // 20,000 USDC
        percentage: 100,
        usdValue: 20000,
      },
    ],

    leverage: 5,
    interestAccrued: 20,
    isOpen: false,
    user: "0x123",
  },

  {
    positionId: 4,
    collateral: { asset: "0xETH", amount: "300" }, // 0.30 ETH
    collateralUsdValue: 550,

    borrowed: [
      {
        assetData: { asset: "0xUSDT", amount: "4500" }, // 450 USDT
        percentage: 100,
        usdValue: 450,
      },
    ],

    leverage: 3,
    interestAccrued: 18,
    isOpen: true,
    user: "0x123",
  },

  {
    positionId: 5,
    collateral: { asset: "0xUSDC", amount: "5000" }, // 5000 USDC
    collateralUsdValue: 5000,

    borrowed: [
      {
        assetData: { asset: "0xETH", amount: "15000" }, // 0.15 ETH
        percentage: 50,
        usdValue: 2750,
      },
      {
        assetData: { asset: "0xUSDT", amount: "25000" }, // 2500 USDT
        percentage: 50,
        usdValue: 2500,
      },
    ],

    leverage: 7,
    interestAccrued: 125,
    isOpen: true,
    user: "0x123",
  },

  {
    positionId: 6,
    collateral: { asset: "0xETH", amount: "500" }, // 0.50 ETH
    collateralUsdValue: 1100,

    borrowed: [
      {
        assetData: { asset: "0xUSDC", amount: "5500" }, // 5500 USDC
        percentage: 100,
        usdValue: 5500,
      },
    ],

    leverage: 2,
    interestAccrued: 45,
    isOpen: false,
    user: "0x123",
  },

  {
    positionId: 7,
    collateral: { asset: "0xUSDT", amount: "2000" }, // 2000 USDT
    collateralUsdValue: 2000,

    borrowed: [
      {
        assetData: { asset: "0xUSDC", amount: "8000" }, // 8000 USDC
        percentage: 70,
        usdValue: 8000,
      },
      {
        assetData: { asset: "0xETH", amount: "30000" }, // 0.30 ETH
        percentage: 30,
        usdValue: 5500,
      },
    ],

    leverage: 10,
    interestAccrued: 200,
    isOpen: true,
    user: "0x123",
  },

  {
    positionId: 8,
    collateral: { asset: "0xUSDC", amount: "10000" }, // 10000 USDC
    collateralUsdValue: 10000,

    borrowed: [
      {
        assetData: { asset: "0xUSDT", amount: "50000" }, // 5000 USDT
        percentage: 100,
        usdValue: 5000,
      },
    ],

    leverage: 4,
    interestAccrued: 85,
    isOpen: true,
    user: "0x123",
  },

  {
    positionId: 9,
    collateral: { asset: "0xETH", amount: "1000" }, // 1.00 ETH
    collateralUsdValue: 2200,

    borrowed: [
      {
        assetData: { asset: "0xUSDC", amount: "11000" }, // 11000 USDC
        percentage: 55,
        usdValue: 11000,
      },
      {
        assetData: { asset: "0xUSDT", amount: "9000" }, // 900 USDT
        percentage: 45,
        usdValue: 9000,
      },
    ],

    leverage: 6,
    interestAccrued: 150,
    isOpen: false,
    user: "0x123",
  },

  {
    positionId: 10,
    collateral: { asset: "0xUSDT", amount: "3000" }, // 3000 USDT
    collateralUsdValue: 3000,

    borrowed: [
      {
        assetData: { asset: "0xETH", amount: "45000" }, // 0.45 ETH
        percentage: 100,
        usdValue: 9900,
      },
    ],

    leverage: 8,
    interestAccrued: 175,
    isOpen: true,
    user: "0x123",
  },
] as const;

// ============================================
// Balance Type Constants
// ============================================
export const BALANCE_TYPE_OPTIONS = ["WB", "MB"] as const;

// ============================================
// Breakdown Data Constants
// ============================================
export const DEPOSIT_AMOUNT_BREAKDOWN_DROPDOWN_DATA = [
  { name: "APE", value: 1200, valueInUSD: 1200 },
  { name: "Polygon", value: 400, valueInUSD: 400 },
  { name: "Optimism", value: 180, valueInUSD: 180 },
] as const;

export const DEPOSIT_AMOUNT_BREAKDOWN_DATA = {
  heading: "Your Deposit Amount Breakdown",
  asset: "USDT",
  totalDeposit: 2000,
  breakdown: [
    { name: "APE", value: 1200 },
    { name: "Polygon", value: 400 },
    { name: "Optimism", value: 180 },
    { name: "Avalanche", value: 120 },
    { name: "Scroll", value: 100 },
  ],
} as const;

export const UNIFIED_BALANCE_BREAKDOWN_DATA = {
  heading: "Unified Balance Breakdown",
  asset: "USDT",
  totalDeposit: 7000,
  breakdown: [
    { name: "APE", value: 3500 },
    { name: "Polygon", value: 1500 },
    { name: "Optimism", value: 800 },
    { name: "Avalanche", value: 700 },
    { name: "Scroll", value: 500 },
  ],
} as const;
