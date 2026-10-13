"use client";

/**
 * Pool rows, the connected margin account's farm positions and its farm history for the V3 Farm
 * list (/farm) — every figure from the Stellar hooks the old Farm page already used, nothing
 * estimated:
 *
 * - Blend single-asset reserves (`useBlendPoolStats`) and the margin account's supply positions
 *   (`useUserBlendPositions`, b-tokens × b-rate);
 * - Aquarius / Soroswap LP pools (`useAllAquariusPoolStats` / `useAllSoroswapPoolStats`) and the
 *   margin account's LP balances, valued pro-rata on the pool's own reserves at oracle prices;
 * - history: Blend supply / withdraw, Aquarius and Soroswap add / remove liquidity events
 *   (Mercury + the bounded RPC fallback, merged inside the useQuery-based event hooks, so they
 *   refresh on ledger ticks and window focus);
 * - health factor: `useV3Account()` (same number as Margin).
 *
 * Earnings have no complete on-chain cost basis on Stellar yet, so the list shows them as $0.00
 * (with a tooltip) instead of guessing.
 */
import { useMemo } from "react";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import {
  useAllAquariusLpPositions,
  useAllAquariusPoolStats,
  useAquariusEvents,
  useBlendEvents,
  useBlendPoolStats,
  useUserBlendPositions,
} from "@/hooks/use-farm";
import { useAllSoroswapPoolStats, useSoroswapEvents, useSoroswapLpPosition } from "@/hooks/use-soroswap";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useV3Account } from "@/hooks/use-v3-account";
import { SOROSWAP_POOLS } from "@/lib/soroswap-utils";
import {
  BLEND_TOKENS,
  FARM_PRICE_SYMBOLS,
  HIDDEN_POOL_IDS,
  POSITION_DUST,
  aquariusRef,
  blendRef,
  normalizeTimestamp,
  poolTitle,
  priceFor,
  soroswapRef,
  type FarmPoolRef,
} from "./farm-pools";

/** One Blend reserve in the Lending/Single Assets table. */
export interface LendRow {
  ref: FarmPoolRef & { kind: "blend" };
  /** Raw symbol (XLM / USDC) and its Blend label (XLM / BLUSDC). */
  symbol: string;
  label: string;
  loaded: boolean;
  totalSupply: number;
  totalBorrow: number;
  supplyUsd: number;
  borrowUsd: number;
  /** Percent numbers (5.23 = 5.23%). */
  supplyApy: number;
  borrowApy: number;
  utilization: number;
  /** The margin account's supplied underlying (dust → 0), its USD value and b-token balance. */
  holding: number;
  holdingUsd: number;
  bTokens: number;
}

/** One Aquarius / Soroswap pool in the LP/Multiple Assets table. */
export interface LpRow {
  ref: FarmPoolRef & { kind: "aquarius" | "soroswap" };
  title: string;
  loaded: boolean;
  reserveA: number;
  reserveB: number;
  usdA: number;
  usdB: number;
  tvlUsd: number;
  totalShares: number;
  /** Aquarius API base trading APY in percent; Soroswap's testnet API has no APY (0). */
  apr: number;
  fee: string;
  /** The margin account's LP shares (dust → 0), their USD value and underlying split. */
  lp: number;
  lpUsd: number;
  amountA: number;
  amountB: number;
}

/** One held position (Positions → Current Position). */
export interface FarmPositionRow {
  id: string;
  ref: FarmPoolRef;
  title: string;
  venue: "Blend" | "Aquarius" | "Soroswap";
  /** "Supply" / "LP". */
  kind: string;
  /** "12.50 XLM" / "3.20 LP". */
  amountText: string;
  /** Second line: b-token balance or the LP's underlying split. */
  detail: string;
  usd: number;
  /** Percent number; Soroswap 0 (no APY source). */
  apy: number;
}

/** One farm event (Positions → Position History). */
export interface FarmHistoryRow {
  key: string;
  venue: "Blend" | "Aquarius" | "Soroswap";
  /** Asset / pool label shown in the first column. */
  asset: string;
  /** Raw symbol for the logo. */
  icon: string;
  type: "Supply" | "Withdraw" | "Add Liquidity" | "Remove Liquidity";
  amount: number;
  amountText: string;
  timestamp: number;
  txHash: string;
}

/** Pro-rata share of a pool's reserves for `lp` shares. */
export function lpShare(lp: number, reserveA: number, reserveB: number, totalShares: number) {
  const ratio = totalShares > 0 && lp > 0 ? lp / totalShares : 0;
  return { amountA: ratio * reserveA, amountB: ratio * reserveB };
}

export function useFarmAccount() {
  const address = useUserStore((s) => s.address);
  const marginAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const { stats: blendStats, isLoading: blendLoading } = useBlendPoolStats();
  const { positions: blendPositions, isLoading: blendPosLoading } = useUserBlendPositions();
  const aquariusPools = useAllAquariusPoolStats();
  const soroswapPools = useAllSoroswapPoolStats();
  const { positions: aqLpPositions, isLoading: aqLpLoading } = useAllAquariusLpPositions(marginAddress);
  // Only one Soroswap pool is configured today, so its LP balance is read with that pool's own
  // tracking symbol / pair (hooks can't be called per pool in a loop).
  const ss0 = SOROSWAP_POOLS[0];
  const { lpBalance: ssLpRaw, isLoading: ssLpLoading } = useSoroswapLpPosition(marginAddress, ss0?.trackingSymbol, ss0?.pairAddress);
  const ssPairAddress = ss0?.pairAddress ?? soroswapPools[0]?.stats?.pairAddress ?? null;
  const prices = useTokenPrices(FARM_PRICE_SYMBOLS);
  const account = useV3Account();

  // Position history — the same useQuery-based event hooks the pool pages use.
  const { events: blendEvents, isLoading: blendEvLoading } = useBlendEvents();
  const { events: aqEvents, isLoading: aqEvLoading } = useAquariusEvents(null, marginAddress);
  const { events: ssEvents, isLoading: ssEvLoading } = useSoroswapEvents(ssPairAddress, marginAddress);

  const lend = useMemo<LendRow[]>(
    () =>
      BLEND_TOKENS.map((symbol) => {
        const s = blendStats[symbol];
        const price = priceFor(prices, symbol);
        const totalSupply = s ? parseFloat(s.totalSupply) || 0 : 0;
        const totalBorrow = s ? parseFloat(s.totalBorrow) || 0 : 0;
        const held = parseFloat(blendPositions[symbol]?.underlyingValue ?? "0") || 0;
        const holding = held > POSITION_DUST ? held : 0;
        const ref = blendRef(symbol) as LendRow["ref"];
        return {
          ref,
          symbol,
          label: ref.label,
          loaded: Boolean(s),
          totalSupply,
          totalBorrow,
          supplyUsd: totalSupply * price,
          borrowUsd: totalBorrow * price,
          supplyApy: s ? parseFloat(s.supplyAPY) || 0 : 0,
          borrowApy: s ? parseFloat(s.borrowAPY) || 0 : 0,
          utilization: s ? parseFloat(s.utilizationRate) || 0 : 0,
          holding,
          holdingUsd: holding * price,
          bTokens: holding > 0 ? parseFloat(blendPositions[symbol]?.bTokenBalance ?? "0") || 0 : 0,
        };
      }),
    [blendStats, blendPositions, prices],
  );

  /** Every configured LP pool (including hidden ones, whose positions still count). */
  const allLp = useMemo<LpRow[]>(() => {
    const ssLp = parseFloat(ssLpRaw ?? "0") || 0;
    const aq = aquariusPools.map(({ pool, stats }) => {
      const [tokenA, tokenB] = pool.tokens;
      const reserveA = stats ? parseFloat(stats.reserveA) || 0 : 0;
      const reserveB = stats ? parseFloat(stats.reserveB) || 0 : 0;
      const totalShares = stats ? parseFloat(stats.totalShares) || 0 : 0;
      const usdA = reserveA * priceFor(prices, tokenA);
      const usdB = reserveB * priceFor(prices, tokenB);
      const bal = parseFloat(aqLpPositions[pool.id] ?? "0") || 0;
      const lp = bal > POSITION_DUST ? bal : 0;
      const { amountA, amountB } = lpShare(lp, reserveA, reserveB, totalShares);
      const apy = parseFloat(stats?.apy ?? "");
      const ref = aquariusRef(pool) as LpRow["ref"];
      return {
        ref,
        title: poolTitle(ref),
        loaded: Boolean(stats),
        reserveA,
        reserveB,
        usdA,
        usdB,
        tvlUsd: usdA + usdB,
        totalShares,
        apr: Number.isFinite(apy) && apy > 0 ? apy * 100 : 0,
        fee: stats?.feeFraction ?? `${(pool.feeFraction / 100).toFixed(2)}%`,
        lp,
        lpUsd: amountA * priceFor(prices, tokenA) + amountB * priceFor(prices, tokenB),
        amountA,
        amountB,
      };
    });
    const ss = soroswapPools.map(({ pool, stats }, i) => {
      const [tokenA, tokenB] = pool.tokens;
      const reserveA = stats ? parseFloat(stats.reserveXLM) || 0 : 0;
      const reserveB = stats ? parseFloat(stats.reserveUSDC) || 0 : 0;
      const totalShares = stats ? parseFloat(stats.totalShares) || 0 : 0;
      const usdA = reserveA * priceFor(prices, tokenA);
      const usdB = reserveB * priceFor(prices, tokenB);
      // Only the first (and today only) Soroswap pool's LP balance is read — see above.
      const lp = i === 0 && ssLp > POSITION_DUST ? ssLp : 0;
      const { amountA, amountB } = lpShare(lp, reserveA, reserveB, totalShares);
      const ref = soroswapRef(pool) as LpRow["ref"];
      return {
        ref,
        title: poolTitle(ref),
        loaded: Boolean(stats),
        reserveA,
        reserveB,
        usdA,
        usdB,
        tvlUsd: usdA + usdB,
        totalShares,
        // Soroswap's public testnet API doesn't expose APY/volume yet.
        apr: 0,
        fee: stats?.feeFraction ?? `${(pool.feeFraction / 100).toFixed(2)}%`,
        lp,
        lpUsd: amountA * priceFor(prices, tokenA) + amountB * priceFor(prices, tokenB),
        amountA,
        amountB,
      };
    });
    return [...ss, ...aq];
  }, [aquariusPools, soroswapPools, aqLpPositions, ssLpRaw, prices]);

  const lp = useMemo(() => allLp.filter((r) => !HIDDEN_POOL_IDS.has(r.ref.id)), [allLp]);

  const positions = useMemo<FarmPositionRow[]>(() => {
    const out: FarmPositionRow[] = [];
    for (const r of lend) {
      if (r.holding <= POSITION_DUST) continue;
      out.push({
        id: r.ref.id,
        ref: r.ref,
        title: r.label,
        venue: "Blend",
        kind: "Supply",
        amountText: `${r.holding.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${r.label}`,
        // "b{sym}" is Blend's own receipt-token naming (bXLM / bUSDC).
        detail: `${r.bTokens.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} b${r.symbol}`,
        usd: r.holdingUsd,
        apy: r.supplyApy,
      });
    }
    for (const r of allLp) {
      if (r.lp <= POSITION_DUST) continue;
      const labels = r.ref.labels;
      out.push({
        id: r.ref.id,
        ref: r.ref,
        title: r.title,
        venue: r.ref.venue,
        kind: "LP",
        amountText: `${r.lp.toFixed(2)} LP`,
        detail: `${r.amountA.toFixed(2)} ${labels[0]} + ${r.amountB.toFixed(2)} ${labels[1]}`,
        usd: r.lpUsd,
        apy: r.apr,
      });
    }
    return out;
  }, [lend, allLp]);

  const history = useMemo<FarmHistoryRow[]>(() => {
    const rows: FarmHistoryRow[] = [];
    for (const ev of blendEvents) {
      const amount = parseFloat(String(ev.underlyingAmount ?? "0")) || 0;
      const label = ev.tokenSymbol === "USDC" ? "BLUSDC" : ev.tokenSymbol;
      rows.push({
        key: `blend:${ev.txHash}:${ev.type}:${ev.tokenSymbol}`,
        venue: "Blend",
        asset: label,
        icon: ev.tokenSymbol,
        type: ev.type === "supply" ? "Supply" : "Withdraw",
        amount,
        amountText: `${amount.toFixed(2)} ${label}`,
        timestamp: normalizeTimestamp(ev.timestamp),
        txHash: ev.txHash ?? "",
      });
    }
    // Aquarius pool events don't say which configured pool they came from once fanned out across
    // all pools, so the row reads "Aquarius LP".
    for (const ev of aqEvents) {
      const amount = parseFloat(ev.shareAmount) || 0;
      rows.push({
        key: `aquarius:${ev.txHash}:${ev.type}`,
        venue: "Aquarius",
        asset: "Aquarius LP",
        icon: "Aquarius",
        type: ev.type === "deposit" ? "Add Liquidity" : "Remove Liquidity",
        amount,
        amountText: `${ev.shareAmount} LP`,
        timestamp: normalizeTimestamp(ev.timestamp),
        txHash: ev.txHash ?? "",
      });
    }
    const ssTitle = ss0 ? poolTitle(soroswapRef(ss0)) : "Soroswap LP";
    for (const ev of ssEvents) {
      const amount = parseFloat(ev.shareAmount) || 0;
      rows.push({
        key: `soroswap:${ev.txHash}:${ev.type}`,
        venue: "Soroswap",
        asset: ssTitle,
        icon: ss0?.tokens[0] ?? "Soroswap",
        type: ev.type === "deposit" ? "Add Liquidity" : "Remove Liquidity",
        amount,
        amountText: `${ev.shareAmount} LP`,
        timestamp: normalizeTimestamp(ev.timestamp),
        txHash: ev.txHash ?? "",
      });
    }
    return rows.sort((a, b) => b.timestamp - a.timestamp);
  }, [blendEvents, aqEvents, ssEvents, ss0]);

  const totals = useMemo(() => {
    const tvl = positions.reduce((s, p) => s + p.usd, 0);
    // Value-weighted APY of the held positions at today's rates (Blend supply APY, Aquarius base
    // trading APY, Soroswap 0 — no APY source). null with nothing held.
    const netApy = tvl > 0 ? positions.reduce((s, p) => s + p.usd * p.apy, 0) / tvl : null;
    return { tvl, netApy };
  }, [positions]);

  const hf = account.now?.hf;
  return {
    connected: Boolean(address),
    hasMargin: account.hasMargin,
    marginAddress,
    lend,
    lp,
    poolsLoading: blendLoading || aquariusPools.some((p) => p.isLoading) || soroswapPools.some((p) => p.isLoading),
    positions,
    positionsLoading: Boolean(marginAddress) && (blendPosLoading || aqLpLoading || ssLpLoading),
    history,
    historyLoading: Boolean(marginAddress) && (blendEvLoading || aqEvLoading || ssEvLoading),
    totals,
    /** null / non-finite = no debt. */
    hf: hf === undefined || !Number.isFinite(hf) ? null : hf,
    prices,
  };
}
