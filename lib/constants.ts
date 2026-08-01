export const navbarItems = [
  { title: "Portfolio", link: "/portfolio", group: "primary" },
  { title: "Earn", link: "/earn", group: "primary" },
  { title: "Margin", link: "/", group: "bordered" },
  { title: "Trade", link: "/trade" , group: "bordered"  },
  { title: "Farm", link: "/farm", group: "bordered" },
  { title: "Analytics", link: "/analytics/overview2", group: "secondary" },
];

export const tradeItems = [
  { title: "Spot", link: "/trade/spot" },
];

// Stellar mainnet supported assets — single Circle USDC (no BLUSDC/AqUSDC/SoUSDC variants)
export const DropdownOptions = [
  "XLM",
  "USDC",
];

// Legacy ETH options (deprecated)
export const LegacyDropdownOptions = [
  "USDT",
  "USDC",
  "ETH",
  "SCROLL",
  "AVALANCHE",
  "OPTIMISM",
  "POLYGON",
  "APE",
  "KATANA",
  "ARBITRUM",
  "BASE",
];


export const iconPaths: Record<string, string> = {
  // Stellar assets
  XLM: "/coins/xlmbg.png",
  USDC: "/icons/usdc-icon.svg",
  // Legacy USDC-variant aliases → Circle USDC icon (display safety)
  BLUSDC: "/icons/usdc-icon.svg",
  AqUSDC: "/icons/usdc-icon.svg",
  SoUSDC: "/icons/usdc-icon.svg",
  AQUSDC: "/icons/usdc-icon.svg",
  SOUSDC: "/icons/usdc-icon.svg",
  AquiresUSDC: "/icons/usdc-icon.svg",
  SoroswapUSDC: "/icons/usdc-icon.svg",
  // Legacy ETH assets (for backwards compatibility)
  USDT: "/icons/usdt-icon.svg",
  ETH: "/icons/eth-icon.png",
  BNB: "/icons/bnb-icon.png",
  SCROLL: "/icons/scroll-icon.png",
  AVALANCHE: "/icons/avalanche-icon.png",
  OPTIMISM: "/icons/optimism-icon.svg",
  POLYGON: "/icons/polygon-icon.png",
  APE: "/icons/ape-icon.png",
  KATANA: "/icons/katana.jpg",
  ARBITRUM: "/icons/arbitrum-icon.svg",
  BASE: "/icons/base-icon.svg",
  WBTC: "/icons/wbtc-icon.png",
};
