"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";

// V3 design: swap card + margin-account block + Position History (components/spot/v3).
// The old orderbook mode (TradingView chart, order book, pair search, Aster/Avantis protocol
// dropdown) ran on mock data with no Stellar backend, so only the swap view is ported.
const SpotPage = dynamic(() => import("@/components/spot/v3/SpotPage").then((mod) => mod.SpotPage), { ssr: false });

const Spot = () => {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return <SpotPage baseSymbol="XLM" />;
};

export default Spot;
