import React from "react";

export interface AssetAmount {
  asset: string;
  amount: string;
}

export interface BorrowInfo {
  assetData: AssetAmount;
  percentage: number;
  usdValue: number;
}

export interface Position {
  positionId: number;

  collateral: AssetAmount;
  collateralUsdValue: number;

  borrowed: BorrowInfo[];

  leverage: number;
  interestAccrued: number;

  isOpen: boolean;
  user: string;
}

export type PositionsArray = Position[];

export interface Collaterals {
  id?: string;
  asset: string;
  amount: number;
  amountInUsd: number;
  balanceType: string;
  unifiedBalance: number;
}

export type OrderType = "limit" | "market" | "trigger";
export type OrderSide = "buy" | "sell";
export type TriggerMode = "limit" | "market";
export type TimeInForce = "GTC" | "Post-Only" | "FOK" | "IOC";
export type RiskRewardRatio =
  | "NA"
  | "1:1"
  | "1:2"
  | "1:3"
  | "2:1"
  | "3:1"
  | "CUSTOM";

export type ActivePositionType = {
  id: string;
  dateTime: string;
  pair: string;
  type: "Limit" | "Market";
  side: "Buy" | "Sell";
  qty: string;
  estFilledPrice: string;
  takeProfit?: {
    label: string;
    value: number;
  }[];
  slTriggerPrice?: number;
  slLimit?: number;
  stopLimit?: number;
  trailPctOrUsd?: string;
  loop?: string;
  currentPnlUsd?: string;
  currentPnlPct?: string;
  status: "Active" | "Closed";
};

export type OpenOrderType = {
  id: string;
  dateTime: string;
  pair: string;
  type: "Limit" | "Market" | "Trigger";
  side: "Buy" | "Sell";
  qty: string;
  price: number;
  takeProfit: {
    label: string;
    value: number;
  }[];
  slTriggerPrice: number;
  slLimit: number;
  trail: number;
  loop: string;
  triggerCondition: string;
  total: string;
};

export type OrderHistoryType = {
  id: string;
  dateTime: string;
  pair: string;
  type: "Limit" | "Market" | "Conditional";
  side: "Buy" | "Sell";
  orderQty: string;
  executedQty: string;
  price: number;
  avgFillPrice: number;
  takeProfit?: {
    label: string;
    value: number;
  }[];
  averageTPPrice: string;
  slTriggerPrice?: number;
  slLimit?: number;
  trailPctOrUsd?: string;
  loop?: string;
  gainPct?: string;
  gainUsd?: string;
  totalGainUsd?: number;
  total: string;
  triggerCondition?: string;
  reduceOnly?: boolean;
  status: "Filled" | "Partially Filled" | "Cancelled";
  orderId?: string;
};

export type TradeHistoryType = {
  id: string;
  dateTime: string;
  pair: string;
  side: "Buy" | "Sell";
  executedQty: string;
  avgFilledPrice: string;
  fee: string;
  role: "Maker" | "Taker";
  total: "Filled" | "Partially Filled";
};

export interface SingleTakeProfit {
  exitPrice: number | null;
  profitPercent: number | null;
  profitAmount: number | null;
}

export interface MultipleTakeProfitRow {
  exitPricePercent: number | null;
  profitPercent: number | null;
  profitAmount: number | null;
  unitsPercent: number | null;
  units: number | null;
  marketPrice: boolean;
}

export interface StopLossConfig {
  triggerPrice: number | null;
  limitPrice: number | null;
  trailVariance: number | null;
  trailVarianceUnit: "USDT" | "USD";
  rrRatio: RiskRewardRatio;
  customRR: string | null;
}

export interface OrderPlacementFormValues {
  // top level
  orderType: OrderType; // limit | market | trigger
  orderSide: OrderSide; // buy | sell

  // loop
  loopEnabled?: boolean;
  noOfLoops?: number | null; // null = ∞

  // prices & size
  triggerPrice?: number | null;
  triggerMode?: TriggerMode; // limit | market

  entryPrice: number | null; // disabled in market
  totalUnits: number | null;
  totalAmount: number | null;

  // take profit
  takeProfitEnabled?: boolean;
  multipleTpEnabled?: boolean;
  singleTakeProfit?: SingleTakeProfit;
  multipleTakeProfits?: MultipleTakeProfitRow[];

  // stop loss
  stopLossEnabled?: boolean;
  stopLoss?: StopLossConfig;

  // derived / selection
  timeInForce?: TimeInForce;

  // calculated (read-only but useful in submit)
  riskAmount?: number;
  riskPercent?: number;
  gainAmount?: number;
  gainPercent?: number;
}

export type PerpsOrderAction = "open" | "close";
export type PerpsOrderSide = "long" | "short";
export type PerpsOrderType =
  | "limit"
  | "market"
  | "trigger"
  | "trailing-entry"
  | "scaled-order"
  | "iceberg"
  | "twap";
export type QuantityUnit = "USDT" | "BTC" | "Cont";
export type TakeProfitType = "price" | "roi" | "pnl" | "change";
export type StopLossType = "price" | "roi" | "pnl" | "change";
export type TriggerPriceType = "last" | "mark" | "index";
export type ExecutionPriceType = "limit" | "market";
export type SizeDistributionType =
  | "equal"
  | "increasing"
  | "descending"
  | "random";
export type TwapFrequencyType = "5s" | "10s" | "20s" | "30s" | "60s";
export type AssetMode = "single" | "multi";
export type MarginMode = "isolated" | "cross";
export type PositionMode = "one-way" | "hedge";
export type SplitSettingsType = "qty-per-order" | "no-of-split-orders";
export type OrderPreferenceType = "faster-execution" | "fixed-distance" | "fixed-price";

export type PerpsModalType = "leverage" | "assetMode" | "marginMode" | "positionMode" | "splitSettings" | "orderPreference" | "advanceTpSl" | "closePosition" | "account" | "futuresUnitSettings" | null;

export interface PerpsOrderPlacementFormValues {

  leverage?: number;
  assetMode?: AssetMode;
  marginMode?: MarginMode;
  positionMode?: PositionMode;
  perpsOrderAction: PerpsOrderAction;
  perpsOrderType: PerpsOrderType;
  loopEnabled?: boolean;
  noOfLoops?: number | null;
  quantity?: number;
  quantityUnit?: QuantityUnit;

  price?: number;

  // Trigger Price
  triggerPriceType?: TriggerPriceType;
  triggerPrice?: number;
  executionPriceType?: ExecutionPriceType;
  executionPrice?: number;

  // trailing entry
  trailingTriggerPriceEnabled?: boolean;
  trailingTriggerPrice?: number;
  trailVarianceValue?: number;

  // scaled order
  lowestPrice?: number;
  highestPrice?: number;
  orderQuantity?: number;
  sizeDistribution?: SizeDistributionType;
  averagePrice?: number; // read-only

  // iceberg
  qtyPerOrder?: number;
  fasterExecution?: number;
  splitSettings?: SplitSettingsType;
  orderPreference?: OrderPreferenceType;
  priceLimitEnabled?: boolean;
  priceLimitValue?: number;

  // twap order
  twapHours?: number;
  twapMinutes?: number;
  twapFrequency?: TwapFrequencyType;

  // take profit
  takeProfitEnabled?: boolean;
  takeProfitValue?: number;
  takeProfitType?: TakeProfitType;

  // stop loss
  stopLossEnabled?: boolean;
  stopLossValue?: number;
  stopLossType?: StopLossType;

  // time in force
  timeInForce?: TimeInForce;
}
export interface TradingPairInfoStats {
  label: string;
  value: string;
  dropdown?: {
    items: string[];
    selectedOption: string;
    onSelect: React.Dispatch<React.SetStateAction<string>>;
  };
}

export type MainTabType =
  | "openOrders"
  | "orderHistory"
  | "positionHistory"
  | "position"
  | "orderDetails"
  | "transactionHistory"
  | "assets";

export type OrderTabType =
  | "limitMarket"
  | "trailingStop"
  | "tpSl"
  | "trigger"
  | "iceberg"
  | "twap";

export interface ColumnPreferenceItem {
  id: string;
  label: string;
  hasToggle: boolean;
}

export type AccountType = "Portfolio Balance" | "Margin Balance";

export interface ChainOption {
  name: string;
  icon: string;
}

export interface TokenOption {
  symbol: string;
  icon: string;
}

export type TpSlMode = "entire_position" | "partial_position" | "trailing" | "mmr_sl";
export type TpSlTriggerPriceType = "Last" | "Mark" | "Index";
export type TpSlValueType = "ROI(%)" | "Change(%)" | "PnL(USDC)";
export type TpSlOrderType = "Limit" | "BBO";
export type TpSlBBOType = "Counterparty 1" | "Counterparty 5" | "Queue 1" | "Queue 5";

export interface TpSlPositionData {
  pair: string;
  leverage: string;
  mode: "Cross" | "Isolated";
  lastPrice: string;
  entryPrice: string;
  markPrice: string;
  estLiquidationPrice: string;
}
