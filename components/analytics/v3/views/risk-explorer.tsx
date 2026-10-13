"use client";

/**
 * Risk Explorer (Stellar-only, no Solana counterpart): the live bad-debt / stress tools run against the
 * real margin-account snapshot, plus the library of modelled stress scenarios. Framed in the V3
 * analytics shell; the explorer itself is the existing `RiskExplorer` component.
 */
import { useMemo } from "react";
import Link from "next/link";
import RiskExplorer from "@/components/analytics/risk-explorer/RiskExplorer";
import { mapSnapshotsToWallets, TOKEN_PRICES } from "@/components/analytics/risk-explorer/constants";
import { useAnalyticsSnapshot, useOracleSnapshot } from "@/hooks/use-analytics";
import { ACTIVE_ASSETS, type StellarAsset } from "@/lib/analytics/stellar/canon";
import { useYou } from "../data";
import { Badge, Icon, Notice, Panel } from "../ui";
import { ViewHead } from "../shell";

/** The modelled scenario pages under /analytics/risk-explorer/*. */
export const SCENARIOS: Array<{ slug: string; cat: string; title: string; desc: string }> = [
  { slug: "single-asset", cat: "Market risk", title: "Single Asset Risk Explorer", desc: "A single asset price drop across every position holding it as collateral or exposure." },
  { slug: "multi-asset-crash", cat: "Market risk", title: "Multi-Asset Correlated Crash", desc: "Correlated crash across the Stellar ecosystem: XLM deep bear, flash crash and stable-pool contagion presets." },
  { slug: "stablecoin-depeg", cat: "Market risk", title: "Stablecoin Depeg Scenario", desc: "BLUSDC / AQUSDC / SOUSDC depegs: collateral value drops and borrower debt exposure changes." },
  { slug: "black-swan", cat: "Market risk", title: "Black Swan Multi-Shock", desc: "Every Stellar risk vector at once: XLM crash, USDC depeg, oracle failure, venue exploit and rate spike." },
  { slug: "lp-il-amplification", cat: "Leverage risk", title: "Leveraged LP Impermanent Loss Amplification", desc: "Leveraged Aquarius / Soroswap LP positions: impermanent loss amplified by Vanna leverage." },
  { slug: "leverage-concentration", cat: "Leverage risk", title: "High-Leverage Concentration Risk", desc: "How much debt sits at each leverage band, and what a move does to the most leveraged." },
  { slug: "leveraged-perp-shock", cat: "Leverage risk", title: "Leveraged External-Pool Shock", desc: "Borrowed Vanna credit deployed into Blend / Aquarius / Soroswap: adverse pool moves cascade back through tracking-token collateral." },
  { slug: "cascading-liquidation", cat: "Systemic risk", title: "Cascading Liquidation Scenario", desc: "The liquidation spiral: a first-wave selloff drives prices down and triggers further waves." },
  { slug: "whale-withdrawal", cat: "Systemic risk", title: "Whale Withdrawal Risk", desc: "Top lenders withdraw: pool utilization spikes, APR surges and borrower health degrades." },
  { slug: "rate-spike", cat: "Systemic risk", title: "Interest Rate Spike", desc: "Utilization pushes borrow rates up the curve; interest erodes borrower health over time." },
  { slug: "oracle-failure", cat: "Protocol risk", title: "Reflector Oracle Failure / Manipulation", desc: "A stale or manipulated Reflector price triggers wrongful liquidations or enables over-borrowing." },
  { slug: "protocol-exploit", cat: "Protocol risk", title: "Integrated Protocol Exploit", desc: "An exploit in Blend, Aquarius or Soroswap impairs the positions held there." },
];

export function RiskExplorerView() {
  const { wallet } = useYou();
  const { result: snapshot } = useAnalyticsSnapshot(wallet);
  const { data: oracle } = useOracleSnapshot();

  // Live Reflector prices where the oracle answered; the explorer's own reference prices otherwise (its existing behaviour).
  const tokenPrices = useMemo(() => {
    const next: Record<StellarAsset, number> = { ...TOKEN_PRICES };
    if (oracle) for (const p of oracle.prices) if (!p.isFallback) next[p.symbol] = p.priceUsd;
    return ACTIVE_ASSETS.reduce((acc, s) => { acc[s] = next[s] ?? TOKEN_PRICES[s]; return acc; }, {} as Record<StellarAsset, number>);
  }, [oracle]);

  const wallets = useMemo(() => (snapshot ? mapSnapshotsToWallets(snapshot.accounts) : []), [snapshot]);

  return (
    <>
      <ViewHead title="Risk Explorer" blurb="Baseline bad debt, a stress heatmap, presets and manual shocks against the live Stellar margin accounts. Read-only - nothing is sent to the chain." />
      {wallets.length === 0 && (
        <Notice tone="warn">No on-chain margin positions loaded yet. The stress tools render as soon as any margin account on the protocol has collateral or debt - they only use real contract-derived snapshots (no synthetic fill).</Notice>
      )}
      <RiskExplorer wallets={wallets} chainName="Stellar (Soroban testnet)" tokenPrices={tokenPrices} />
      <Panel title="Scenario library" sub="Each scenario runs on a modelled sample portfolio, not on live accounts. Use them to understand mechanisms; use the tools above and the What-if Calculator for the real accounts.">
        <div className="an-rcards" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))" }}>
          {SCENARIOS.map((s) => (
            <article className="an-oracle-card" key={s.slug}>
              <div className="an-row an-between"><Badge tone="accent">{s.cat}</Badge><Badge tone="warn">Modelled</Badge></div>
              <div>
                <div style={{ fontWeight: 700 }}>{s.title}</div>
                <p className="an-muted" style={{ fontSize: 12.5, marginTop: 4 }}>{s.desc}</p>
              </div>
              <Link className="an-btn an-sm" href={`/analytics/risk-explorer/${s.slug}`}>Run scenario <Icon name="arrow" /></Link>
            </article>
          ))}
        </div>
      </Panel>
    </>
  );
}
