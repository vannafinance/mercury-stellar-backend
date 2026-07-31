import Image from "next/image";

// Analytics-only icon map. Restricted to the asset universe Vanna actually
// supports on Soroban (XLM + BLUSDC/AQUSDC/SOUSDC) plus the symbols the
// risk-explorer simulators reference (USDC canonical, USDT). Anything
// outside this list falls through to the generic coin placeholder in
// `default.svg`.
const COIN_ICON_MAP: Record<string, string> = {
  // ── Stellar-native assets ────────────────────────────────────
  XLM:       "/coins/xlmbg.png",
  BLUSDC:    "/icons/usdc-icon.svg",
  AQUSDC:    "/icons/usdc-icon.svg",
  SOUSDC:    "/icons/usdc-icon.svg",
  // ── Canonical references used by risk-engine pricing ────────
  USDC:      "/icons/usdc.svg",
  USDT:      "/icons/usdt.svg",
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
