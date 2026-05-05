"use client";

import { useEffect } from "react";
import { useOraclePrices, _setLatestPrices } from "@/hooks/use-oracle-prices";

export function OraclePriceSync({ children }: { children: React.ReactNode }) {
  const { data } = useOraclePrices();

  useEffect(() => {
    if (data) _setLatestPrices(data);
  }, [data]);

  return <>{children}</>;
}
