export interface Token {
  id: string;
  symbol: string;
  name: string;
  logo: string | null;
  decimals: number;
  chain: string;
  issuer?: string;
  isNative?: boolean;
  isVerified?: boolean;
}

export interface RouteStep {
  tokenIn: Token;
  tokenOut: Token;
  protocol: string;
  poolType?: string;
  poolFee?: string;
  percentage?: number;
}

export interface DexOption {
  id: string;
  name: string;
  logo?: string;
  isAvailable?: boolean;
  tag?: string;
}

export type SwapButtonState =
  | "connect_wallet"
  | "select_token"
  | "enter_amount"
  | "loading_quote"
  | "insufficient_balance"
  | "approve_token"
  | "ready"
  | "disabled";

export type PriceImpactLevel = "low" | "medium" | "high" | null;

export type SwapErrorType =
  | "NO_ROUTE_FOUND"
  | "PRICE_IMPACT_TOO_HIGH"
  | "INSUFFICIENT_LIQUIDITY"
  | "INVALID_AMOUNT"
  | "NETWORK_ERROR"
  | "QUOTE_EXPIRED"
  | "SLIPPAGE_EXCEEDED";

export interface SwapUIState {
  tokenIn: Token | null;
  tokenOut: Token | null;
  amountIn: string;
  amountOut: string;
  amountInUsd: string | null;
  amountOutUsd: string | null;
  exchangeRate: string | null;
  exchangeRateInverse: string | null;
  priceImpact: string | null;
  priceImpactLevel: PriceImpactLevel;
  minReceived: string | null;
  fee: string | null;
  networkCost: string | null;
  route: RouteStep[] | null;
  selectedDex: string;
  availableDexes: DexOption[];
  slippage: string;
  slippageMode: "auto" | "custom";
  deadline: number;
  isWalletConnected: boolean;
  walletAddress: string | null;
  tokenInBalance: string | null;
  tokenOutBalance: string | null;
  isQuoteLoading: boolean;
  isQuoteStale: boolean;
  isTokenInModalOpen: boolean;
  isTokenOutModalOpen: boolean;
  isSettingsOpen: boolean;
  isDetailsExpanded: boolean;
  errorMessage: string | null;
  errorType: SwapErrorType | null;
  tokenSearchQuery: string;
}
