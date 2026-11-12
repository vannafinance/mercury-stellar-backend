"use client";

/**
 * One Earn pool (V3 design `#earn-<SYM>`): Back to pools, the pool's stats strip, Positions |
 * Details | Activity | Collateral and Limits | Analytics, and the Supply / Withdraw form (inline at
 * ≥ 1280 px; below that a fixed bottom bar that opens the same form in a modal).
 */
import "./earn-v3.css";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/v3/icons";
import { setSelectedPool, useSelectedPoolStore } from "@/store/selected-pool-store";
import { EarnForm, EarnFormModal, type EarnMode } from "./earn-form";
import { TabActivity, TabAnalytics, TabCollateral, TabDetails, TabPositions } from "./earn-pool-tabs";
import { NoData, SV } from "./earn-ui";
import { fP, fQ } from "./earn-format";
import { EARN_POOLS, findPool } from "./earn-pools";
import { useEarnV3 } from "./use-earn-v3";

type DTab = "positions" | "details" | "activity" | "collateral" | "analytics";
const DTABS: [DTab, string, string?][] = [
  ["positions", "Positions", "Your Positions"],
  ["details", "Details"],
  ["activity", "Activity"],
  ["collateral", "Collateral", "Collateral and Limits"],
  ["analytics", "Analytics"],
];

/** Pool screen for route id `id` (XLM / BLUSDC / AqUSDC / SoUSDC and their aliases, case-insensitive). */
export function EarnPool({ id, initialTab = "details", initialMode = "supply" }: { id: string; initialTab?: DTab; initialMode?: EarnMode }) {
  const router = useRouter();
  const d = useEarnV3();
  const def = findPool(decodeURIComponent(id));
  const [tab, setTab] = useState<DTab>(initialTab);
  const [sheet, setSheet] = useState<EarnMode | null>(null);

  // Keep the shared selected-pool store in step with the route (other app surfaces read it).
  useEffect(() => {
    if (!def) return;
    if (useSelectedPoolStore.getState().selectedAsset === def.assetType) return;
    setSelectedPool(def.assetType, { id: def.sym, chain: def.key, title: def.sym, tag: "Active" });
  }, [def]);

  const back = (
    <nav aria-label="Breadcrumb">
      <button type="button" className="earn-back" onClick={() => router.push("/earn")}>
        {SV.chevL}Back to pools
      </button>
    </nav>
  );

  if (!def) {
    return (
      <div className="earn earn-pg">
        <header className="earn-ph">{back}</header>
        <NoData text={`There is no Vanna lending pool for "${decodeURIComponent(id)}". Supported pools: ${EARN_POOLS.map((p) => p.sym).join(", ")}.`} />
      </div>
    );
  }
  const sym = def.sym;
  const p = d.pools[def.key];
  const px = d.prices[def.key];
  const u = (n: number) => (px > 0 ? `$${fQ(n * px, 2)}` : `$${fQ(0, 2)}`);
  const strip: [string, string, string?][] = [
    ["Total Supply", u(p.totalSupplied), `${fQ(p.totalSupplied)} ${sym}`],
    ["Available Liquidity", u(p.availableLiquidity), `${fQ(p.availableLiquidity)} ${sym}`],
    ["Utilization Rate", fP(p.utilization)],
    ["Supply APY", fP(p.supplyApy)],
  ];
  const steps: [string, string][] = [
    ["Supply assets", `Deposit ${sym} into the vault to provide liquidity`],
    ["Receive vault shares", `Get v${sym} tokens representing your share of the pool`],
    ["Earn yield", "Borrowers pay interest which accrues to your position automatically"],
    ["Withdraw anytime", "Redeem your vault shares for the underlying asset plus earned yield, up to the pool's available liquidity"],
  ];

  return (
    <div className="earn earn-pg" data-pool={sym}>
      <header className="earn-ph">
        {back}
        <div className="earn-pt">
          <Icon sym={sym} className="earn-i34" />
          <div className="earn-ptn">
            <h1>{sym}</h1>
            <span className="earn-act-tag">Active</span>
          </div>
        </div>
      </header>
      <section className="earn-gs" aria-label="Statistics Overview">
        {strip.map(([k, v, s]) => (
          <article key={k}>
            <h3>{k}</h3>
            <div>
              <p className="num">{v}</p>
              {s && <p className="s num">{s}</p>}
            </div>
          </article>
        ))}
      </section>
      <section className="earn-pbody" aria-label="Vault Details and Actions">
        <article className="earn-pmain">
          <nav className="earn-btabs" aria-label="Vault Information Tabs">
            {DTABS.map(([k, s, l]) => (
              <button key={k} type="button" className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {l ? (
                  <>
                    <span className="earn-short">{s}</span>
                    <span className="earn-long">{l}</span>
                  </>
                ) : (
                  s
                )}
              </button>
            ))}
          </nav>
          {tab === "positions" && <TabPositions def={def} d={d} />}
          {tab === "details" && <TabDetails def={def} d={d} />}
          {tab === "activity" && <TabActivity def={def} d={d} />}
          {tab === "collateral" && <TabCollateral d={d} />}
          {tab === "analytics" && <TabAnalytics def={def} d={d} />}
        </article>
        <aside className="earn-paside" aria-label="Transaction Form">
          <EarnForm key={sym} symbol={sym} initialMode={initialMode} />
          <div className="earn-how">
            <p className="t">How it works</p>
            {steps.map(([t, s], i) => (
              <div key={t} className="earn-hs">
                <span className="n">{i + 1}</span>
                <div>
                  <span className="a">{t}</span>
                  <span className="b">{s}</span>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </section>
      <div className="earn-sheet" role="region" aria-label="Liquidity Actions">
        <span className="earn-handle" aria-hidden="true" />
        <nav className="earn-btabs fm">
          <button type="button" className="on" onClick={() => setSheet("supply")}>
            Supply Liquidity
          </button>
          <button type="button" onClick={() => setSheet("withdraw")}>
            Withdraw Liquidity
          </button>
        </nav>
      </div>
      {sheet && <EarnFormModal symbol={sym} mode={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
