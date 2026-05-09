export interface WalletPosition {
  address: string;
  collateral: number;
  debt: number;
  hf: number;
  primaryAsset: string;
  leverageX: number;
}

/** USD reference prices for simulation (mock oracle). */
export const TOKEN_PRICES: Record<string, number> = {
  ETH: 3500,
  WBTC: 98_000,
  weETH: 3550,
  USDC: 1,
  USDT: 1,
  DAI: 1,
};

/** Standard collateral assets available in the Risk Explorer asset selector. */
export const SIM_ASSETS = [
  { symbol: "ETH", name: "Ether (native)", icon: "◆" },
  { symbol: "WBTC", name: "Wrapped Bitcoin", icon: "₿" },
  { symbol: "weETH", name: "Ether.fi weETH", icon: "⬢" },
  { symbol: "USDC", name: "USD Coin", icon: "$" },
  { symbol: "USDT", name: "Tether USD", icon: "₮" },
  { symbol: "DAI", name: "DAI Stablecoin", icon: "ⓓ" },
] as const;

const COLLATERAL_SYMBOLS = SIM_ASSETS.map((a) => a.symbol);

export function generateWallets(chainId: number): WalletPosition[] {
  const seed = chainId * 7;
  const gen = (i: number) => {
    const r = Math.sin(seed + i * 13.7) * 10000;
    return Math.abs(r - Math.floor(r));
  };

  const wallets: WalletPosition[] = [];
  const pickAsset = (i: number) => COLLATERAL_SYMBOLS[i % COLLATERAL_SYMBOLS.length];

  const underwaterCount = 2 + Math.floor(gen(0) * 3);
  for (let i = 0; i < underwaterCount; i++) {
    const coll = 20000 + gen(i + 100) * 300000;
    const hf = 0.75 + gen(i + 200) * 0.24;
    const debt = (coll * 0.9) / hf;
    wallets.push({
      address: `0x${(seed * 1000 + i).toString(16).padStart(4, "0")}...${(i * 7 + 3).toString(16).padStart(4, "0")}`,
      collateral: coll,
      debt,
      hf,
      primaryAsset: pickAsset(i),
      leverageX: coll / Math.max(coll - debt, 1),
    });
  }

  const criticalCount = 3 + Math.floor(gen(1) * 4);
  for (let i = 0; i < criticalCount; i++) {
    const coll = 30000 + gen(i + 300) * 500000;
    const hf = 1.001 + gen(i + 400) * 0.098;
    const debt = (coll * 0.9) / hf;
    wallets.push({
      address: `0x${(seed * 2000 + i).toString(16).padStart(4, "0")}...${(i * 11 + 5).toString(16).padStart(4, "0")}`,
      collateral: coll,
      debt,
      hf,
      primaryAsset: pickAsset(i + 2),
      leverageX: coll / Math.max(coll - debt, 1),
    });
  }

  const warningCount = 5 + Math.floor(gen(2) * 6);
  for (let i = 0; i < warningCount; i++) {
    const coll = 25000 + gen(i + 500) * 600000;
    const hf = 1.1 + gen(i + 600) * 0.1;
    const debt = (coll * 0.9) / hf;
    wallets.push({
      address: `0x${(seed * 3000 + i).toString(16).padStart(4, "0")}...${(i * 13 + 9).toString(16).padStart(4, "0")}`,
      collateral: coll,
      debt,
      hf,
      primaryAsset: pickAsset(i + 4),
      leverageX: coll / Math.max(coll - debt, 1),
    });
  }

  const cautionCount = 12 + Math.floor(gen(3) * 8);
  for (let i = 0; i < cautionCount; i++) {
    const coll = 10000 + gen(i + 700) * 800000;
    const hf = 1.2 + gen(i + 800) * 0.3;
    const debt = (coll * 0.9) / hf;
    wallets.push({
      address: `0x${(seed * 4000 + i).toString(16).padStart(4, "0")}...${(i * 17 + 2).toString(16).padStart(4, "0")}`,
      collateral: coll,
      debt,
      hf,
      primaryAsset: pickAsset(i + 1),
      leverageX: coll / Math.max(coll - debt, 1),
    });
  }

  const safeCount = 25 + Math.floor(gen(4) * 15);
  for (let i = 0; i < safeCount; i++) {
    const coll = 5000 + gen(i + 900) * 1000000;
    const hf = 1.5 + gen(i + 1000) * 3;
    const debt = (coll * 0.9) / hf;
    wallets.push({
      address: `0x${(seed * 5000 + i).toString(16).padStart(4, "0")}...${(i * 19 + 7).toString(16).padStart(4, "0")}`,
      collateral: coll,
      debt,
      hf,
      primaryAsset: pickAsset(i + 3),
      leverageX: coll / Math.max(coll - debt, 1),
    });
  }

  return wallets.sort((a, b) => a.hf - b.hf);
}
