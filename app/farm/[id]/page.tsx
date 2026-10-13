"use client";

/**
 * /farm/:id — V3 farm pool page (Blend supply / withdraw, Aquarius & Soroswap add / remove
 * liquidity from the margin account, position + history, analytics).
 * See components/farm/pool-detail.tsx.
 */
import { PoolDetail } from "@/components/farm/pool-detail";

export default function FarmDetailPage() {
  return <PoolDetail />;
}
