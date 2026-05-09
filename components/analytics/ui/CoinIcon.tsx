import Image from "next/image";

const COIN_ICON_MAP: Record<string, string> = {
  ETH:       "/icons/eth.svg",
  WBTC:      "/icons/wbtc-icon.png",
  weETH:     "/icons/rst-Eth-icon.png",
  BTC:       "/icons/btc.svg",
  USDC:      "/icons/usdc.svg",
  USDT:      "/icons/usdt.svg",
  DAI:       "/icons/dai.svg",
  SOL:       "/icons/sol.svg",
  BNB:       "/icons/bnb.svg",
  MATIC:     "/icons/matic.svg",
  AAVE:      "/icons/aave.svg",
  LINK:      "/icons/link.svg",
  OP:        "/icons/op.svg",
  XLM:       "/icons/xlm.svg",
  BASE:      "/icons/base-icon.svg",
  ARB:       "/icons/arbitrum-icon.svg",
  AVAX:      "/icons/avax.svg",
  UNI:       "/icons/uniswap.png",
  ADA:       "/icons/ada.svg",
  DOT:       "/icons/dot.svg",
  DOGE:      "/icons/doge.svg",
  XRP:       "/icons/xrp.svg",
  TRX:       "/icons/trx.svg",
  LTC:       "/icons/ltc.svg",
  ATOM:      "/icons/atom.svg",
};

interface CoinIconProps {
  symbol: string;
  size?: number;
  className?: string;
}

export default function CoinIcon({ symbol, size = 20, className = "" }: CoinIconProps) {
  const src = COIN_ICON_MAP[symbol.toUpperCase()] ?? "/icons/default.svg";
  return (
    <Image
      src={src}
      alt={symbol}
      width={size}
      height={size}
      className={`rounded-full object-contain flex-shrink-0 ${className}`}
    />
  );
}
