"use client";

/**
 * V3 Farm list screen (/farm) — the design's farm.js list view on live Stellar data:
 * banner · stats strip (connected) · Vaults | Positions · LP/Multiple Assets | Lending/Single Assets ·
 * pool / vault / threshold filters + search · sortable tables.
 *
 * Data ({@link useFarmAccount}): Blend reserves + the margin account's Blend supply, Aquarius /
 * Soroswap pools + the margin account's LP balances, and the account's Blend / Aquarius / Soroswap
 * history (useQuery-based event hooks). A row opens /farm/:id with the same ids as before
 * (xlm, usdc, soroswap-xlm-usdc, aquarius-xlm-usdc).
 */
import "./farm-v3.css";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Banner, Info, Seg, StatStrip } from "@/components/v3/ui";
import { Icon, IC } from "@/components/v3/icons";
import { cmp, hfFmt, nf, pct, usd, usdC } from "@/components/v3/format";
import { hfZone, LIQ_HF } from "@/lib/account-model";
import { VannaLoader } from "@/components/v3/vanna-loader";
import { useFarmStore } from "@/store/farm-store";
import { useFarmAccount, type FarmPositionRow, type LendRow, type LpRow } from "./use-farm-account";
import { Cell, CheckDropdown, SortHead, Venue, sortRows, useOutside, type SortState } from "./fm-ui";
import { timeLbl, txUrl } from "./farm-pools";

type Tab = "vaults" | "positions";
type Cat = "lp" | "lend";
type PosTab = "current" | "history";

/** "100M" / "$2.5k" / "8%" → number; null when empty or unparsable. */
const parseThr = (s: string) => {
  const m = s.trim().replace(/[$,%\s]/g, "").match(/^(\d*\.?\d+)([kmb])?$/i);
  return m ? parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase() as "k" | "m" | "b"] ?? 1) : null;
};

/** Two overlapping pool logos (LP rows). */
function PairIcons({ a, b }: { a: string; b: string }) {
  return (
    <span className="fm-tk" style={{ gap: 0 }}>
      <Icon sym={a} className="fm-ico16" />
      <Icon sym={b} className="fm-ico16" />
    </span>
  );
}

export function FarmList() {
  const farm = useFarmAccount();
  // Restore whichever Vaults sub-tab (LP/Multiple Assets vs Lending/Single Assets) was active when
  // the user last clicked into a pool page — farm-store's tabType is set on every row click and
  // isn't reset on unmount, so it still holds the right value here on remount.
  const lastTabType = useFarmStore((s) => s.tabType);
  const setFarmData = useFarmStore((s) => s.set);
  const [tab, setTab] = useState<Tab>("vaults");
  const [cat, setCat] = useState<Cat>(() => (lastTabType === "multi" ? "lp" : "lend"));
  const [posTab, setPosTab] = useState<PosTab>("current");
  const [q, setQ] = useState("");
  const [poolSel, setPoolSel] = useState<string[]>([]);
  const [vaultSel, setVaultSel] = useState<string[]>([]);
  const [op, setOp] = useState<"gt" | "lt">("gt");
  const [thr, setThr] = useState("");
  const [thrOpen, setThrOpen] = useState(false);
  const [sort, setSort] = useState<SortState>(null);
  const thrRef = useOutside(thrOpen, () => setThrOpen(false));

  const resetList = () => {
    setPoolSel([]);
    setVaultSel([]);
    setThr("");
    setSort(null);
    setThrOpen(false);
  };
  const lpCat = tab === "vaults" && cat === "lp";
  const thrVal = parseThr(thr);
  const keepThr = (v: number | null) => thrVal === null || (v !== null && (op === "gt" ? v > thrVal : v < thrVal));
  const keepAsset = (s: string) => (!poolSel.length || poolSel.includes(s)) && (!vaultSel.length || vaultSel.includes(s));
  const thrName = lpCat ? "Pool TVL" : "Total Borrow";
  const thrLbl = thrVal === null ? "Anything" : `${op === "gt" ? "Over" : "Under"} ${usdC(thrVal)}`;

  const assets = useMemo(
    () =>
      tab === "positions"
        ? [...new Set((posTab === "history" ? farm.history.map((r) => r.asset) : farm.positions.map((r) => r.title)).filter(Boolean))]
        : cat === "lp"
          ? farm.lp.map((r) => r.title)
          : farm.lend.map((r) => r.label),
    [tab, posTab, cat, farm.history, farm.positions, farm.lp, farm.lend],
  );
  const poolsLbl = poolSel.length ? (poolSel.length > 2 ? `${poolSel.length} Pools` : poolSel.join(", ")) : "All Pools";

  /** Remember which sub-tab a pool page was opened from (see the restore note above). */
  const openPool = (single: boolean) => setFarmData({ tabType: single ? "single" : "multi" });

  // ---- Stats strip (connected) ----
  const t = farm.totals;
  const hf = farm.hf;
  const strip = farm.connected && (
    <div className="fm-fsw">
      <StatStrip
        center
        n={5}
        items={[
          { icon: IC.wallet, label: "Your Deposit TVL", value: usd(t.tvl) },
          {
            icon: IC.coins,
            label: (
              <>
                Your Earnings <Info text="Not tracked yet: Stellar farm positions have no complete on-chain cost basis, so earnings aren't computed instead of being guessed." />
              </>
            ),
            value: usd(0),
          },
          {
            icon: IC.pct,
            label: (
              <>
                Net Farm APY{" "}
                <Info text="Value-weighted yearly yield of your farm positions at today's rates: Blend supply APY, Aquarius base trading APY; Soroswap's testnet API has no APY, so it counts as 0%. Borrow cost isn't subtracted." />
              </>
            ),
            value: pct(t.netApy ?? 0),
          },
          {
            icon: IC.spark,
            label: (
              <>
                Pending Rewards <Info text="Protocol reward emissions (BLND / AQUA) aren't read by the app yet, so they aren't shown." />
              </>
            ),
            value: usd(0),
          },
          {
            icon: IC.heart,
            label: (
              <>
                Net Health Factor <Info text={`Your margin account's health factor, the same number as on Margin; at ${nf(LIQ_HF, 2)} or below it can be liquidated.`} />
              </>
            ),
            value: hfFmt(hf),
            // Same colouring as Margin: green "No debt", zone colour otherwise.
            valueClass: hf === null ? "z-ok" : hfZone(hf),
          },
        ]}
      />
    </div>
  );

  // ---- Tables ----
  const query = q.trim().toLowerCase();
  const lendTable = () => {
    const items = farm.lend
      .filter((r) => (!query || `${r.symbol} ${r.label} blend`.toLowerCase().includes(query)) && keepAsset(r.label) && keepThr(r.borrowUsd))
      .map((r: LendRow) => {
        const ld = !r.loaded && farm.poolsLoading;
        return {
          v: { asset: r.label, prot: "Blend", dep: r.supplyUsd, bor: r.borrowUsd, sup: r.supplyApy, bora: r.borrowApy, util: r.utilization, hold: r.holdingUsd },
          el: (
            <Link key={r.ref.id} href={`/farm/${r.ref.id}`} onClick={() => openPool(true)} className="fm-tr fm-row k8" aria-label={`Open ${r.label} pool`}>
              <Cell
                v={
                  <span className="fm-tk">
                    <Icon sym="XLM" className="fm-chn" />
                    <Icon sym={r.symbol} className="fm-ico16" />
                    {r.label}
                  </span>
                }
                mini={["Blend", "Supply"]}
              />
              <Cell v={<Venue name="Blend" />} />
              <Cell v={ld ? "..." : `${cmp(r.totalSupply)} ${r.label}`} mini={usd(r.supplyUsd)} />
              <Cell v={ld ? "..." : `${cmp(r.totalBorrow)} ${r.label}`} mini={usd(r.borrowUsd)} />
              <Cell v={pct(r.supplyApy)} />
              <Cell v={pct(r.borrowApy)} />
              <Cell v={pct(r.utilization)} />
              <Cell v={`${cmp(r.holding)} ${r.label}`} mini={usd(r.holdingUsd)} />
            </Link>
          ),
        };
      });
    const rows = sortRows(items, sort).map((x) => x.el);
    return (
      <div className="fm-tbl">
        <SortHead
          cls="k8"
          sort={sort}
          onSort={setSort}
          cols={[
            ["Asset", "asset"],
            ["Protocol", "prot"],
            ["Total Deposits", "dep"],
            ["Total Borrow", "bor"],
            ["Supply APY", "sup", "Blend's current yearly supply yield on this reserve (net of the backstop take rate)."],
            ["Borrow APY", "bora", "Blend's current yearly borrow rate on this reserve."],
            ["Utilization", "util"],
            ["Holding", "hold", "What your margin account has supplied to this Blend reserve."],
          ]}
        />
        {rows.length ? rows : <div className="fm-none">No pools match these filters</div>}
      </div>
    );
  };

  const lpTable = () => {
    const items = farm.lp
      .filter((r) => (!query || `${r.title} ${r.ref.tokens.join(" ")} ${r.ref.venue}`.toLowerCase().includes(query)) && keepAsset(r.title) && keepThr(r.tvlUsd))
      .map((r: LpRow) => {
        const ld = !r.loaded && farm.poolsLoading;
        const [a, b] = r.ref.tokens;
        const [la, lb] = r.ref.labels;
        return {
          v: { asset: r.title, prot: r.ref.venue, tvl: r.tvlUsd, ra: r.usdA, rb: r.usdB, apr: r.apr, fee: parseFloat(r.fee) || 0, hold: r.lpUsd },
          el: (
            <Link key={r.ref.id} href={`/farm/${r.ref.id}`} onClick={() => openPool(false)} className="fm-tr fm-row k8" aria-label={`Open ${r.title} pool`}>
              <Cell
                v={
                  <span className="fm-tk">
                    <Icon sym="XLM" className="fm-chn" />
                    <PairIcons a={a} b={b} />
                    {r.title}
                  </span>
                }
                mini={[r.ref.venue, "LP"]}
              />
              <Cell v={<Venue name={r.ref.venue} />} />
              <Cell v={ld ? "..." : `${cmp(r.totalShares)} LP`} mini={usd(r.tvlUsd)} />
              <Cell v={ld ? "..." : `${cmp(r.reserveA)} ${la}`} mini={usd(r.usdA)} />
              <Cell v={ld ? "..." : `${cmp(r.reserveB)} ${lb}`} mini={usd(r.usdB)} />
              <Cell v={pct(r.apr)} />
              <Cell v={ld ? "..." : r.fee} />
              <Cell v={`${cmp(r.lp)} LP`} mini={usd(r.lpUsd)} />
            </Link>
          ),
        };
      });
    const rows = sortRows(items, sort).map((x) => x.el);
    return (
      <div className="fm-tbl">
        <SortHead
          cls="k8"
          sort={sort}
          onSort={setSort}
          cols={[
            ["Pool", "asset"],
            ["DEX", "prot"],
            ["DEX LP TVL", "tvl", "Total LP shares outstanding; the chip is the pool's value (both reserves at oracle prices)."],
            ["DEX TVL Token 0", "ra"],
            ["DEX TVL Token 1", "rb"],
            ["Pool APR", "apr", "Aquarius: the AMM API's base trading APY. Soroswap's testnet API has no APY, so it reads 0%."],
            ["Fees", "fee"],
            ["Holding", "hold", "Your margin account's LP shares in this pool, valued pro-rata on its reserves."],
          ]}
        />
        {rows.length ? rows : <div className="fm-none">No pools match these filters</div>}
      </div>
    );
  };

  const posTable = () => {
    if (!farm.connected || !farm.positions.length)
      return <div className="fm-empty">{farm.connected && farm.positionsLoading ? <VannaLoader size="block" /> : "No farm positions yet"}</div>;
    const items = farm.positions
      .filter((r) => keepAsset(r.title))
      .map((r: FarmPositionRow) => ({
        v: { asset: r.title, prot: r.venue, hold: r.usd, apy: r.apy, type: r.kind },
        el: (
          <Link key={r.id} href={`/farm/${r.id}`} onClick={() => openPool(r.venue === "Blend")} className="fm-tr fm-row k5" aria-label={`Open ${r.title}`}>
            <Cell
              v={
                <span className="fm-tk">
                  <Icon sym="XLM" className="fm-chn" />
                  {r.ref.kind === "blend" ? <Icon sym={r.ref.token} className="fm-ico16" /> : <PairIcons a={r.ref.tokens[0]} b={r.ref.tokens[1]} />}
                  {r.title}
                </span>
              }
              mini={[r.venue, r.kind]}
            />
            <Cell v={<Venue name={r.venue} />} />
            <Cell v={r.amountText} mini={[usd(r.usd), r.detail]} />
            <Cell v={pct(r.apy)} />
            <Cell v={r.kind === "LP" ? "Liquidity" : "Lending"} />
          </Link>
        ),
      }));
    const rows = sortRows(items, sort).map((x) => x.el);
    return (
      <div className="fm-tbl">
        <SortHead
          cls="k5"
          sort={sort}
          onSort={setSort}
          cols={[
            ["Asset", "asset"],
            ["Protocol", "prot"],
            ["Holdings", "hold"],
            ["APY", "apy", "Blend: current supply APY. Aquarius: base trading APY from its AMM API. Soroswap: no APY source on testnet (0%)."],
            ["Type", "type"],
          ]}
        />
        {rows.length ? rows : <div className="fm-none">No positions match these filters</div>}
      </div>
    );
  };

  const histTable = () => {
    if (!farm.connected || !farm.history.length)
      return <div className="fm-empty">{farm.connected && farm.historyLoading ? <VannaLoader size="block" /> : "No farm activity yet"}</div>;
    const items = farm.history
      .filter((r) => keepAsset(r.asset))
      .map((r, i) => ({
        v: { asset: r.asset, prot: r.venue, amt: r.amount, tx: -i },
        el: (
          <div key={`${r.key}-${i}`} className="fm-tr fm-row k4 static">
            <Cell
              v={
                <span className="fm-tk">
                  <Icon sym={r.icon} className="fm-ico16" />
                  {r.asset}
                </span>
              }
              mini={r.type}
            />
            <Cell v={<Venue name={r.venue} />} mini={timeLbl(r.timestamp)} />
            <Cell v={r.amountText} />
            <Cell
              v={
                r.txHash ? (
                  <a className="fm-link" href={txUrl(r.txHash)} target="_blank" rel="noreferrer">
                    {r.txHash.slice(0, 8)}…
                  </a>
                ) : (
                  "N/A"
                )
              }
            />
          </div>
        ),
      }));
    const rows = sortRows(items, sort).map((x) => x.el);
    return (
      <div className="fm-tbl">
        <SortHead
          cls="k4"
          sort={sort}
          onSort={setSort}
          cols={[
            ["Asset", "asset"],
            ["Protocol", "prot"],
            ["Amount", "amt"],
            ["Tx Hash", "tx"],
          ]}
        />
        {rows.length ? rows : <div className="fm-none">No activity matches these filters</div>}
      </div>
    );
  };

  const pos = tab === "positions";
  const body = pos ? (posTab === "history" ? histTable() : posTable()) : lpCat ? lpTable() : lendTable();

  return (
    <div className="v3">
      <div className="page">
        <Banner page="farm" />
        {strip}

        <div className={`fm-bar ${farm.connected ? "st" : ""}`}>
          <Seg<Tab>
            value={tab}
            options={[
              ["vaults", "Vaults"],
              ["positions", "Positions"],
            ]}
            onChange={(v) => {
              setTab(v);
              resetList();
            }}
          />
          {pos ? (
            <Seg<PosTab>
              value={posTab}
              options={[
                ["current", "Current Position"],
                ["history", "Position History"],
              ]}
              onChange={(v) => {
                setPosTab(v);
                setSort(null);
                setPoolSel([]);
              }}
            />
          ) : (
            <Seg<Cat>
              value={cat}
              options={[
                ["lp", "LP/Multiple Assets"],
                ["lend", "Lending/Single Assets"],
              ]}
              onChange={(v) => {
                setCat(v);
                resetList();
              }}
            />
          )}
        </div>

        <div className="fm-filters">
          <div className="fm-fl">
            <CheckDropdown
              options={assets}
              selected={poolSel}
              onChange={setPoolSel}
              placeholder="Search for pools"
              withIcons={!pos && !lpCat}
              trigger={(open, toggle) => (
                <button type="button" className={`fm-dd ${poolSel.length ? "set" : ""}`} aria-haspopup="listbox" aria-expanded={open} onClick={toggle}>
                  <Icon sym="XLM" className="fm-ico16" />
                  {poolsLbl} {IC.chev}
                </button>
              )}
            />
            {!pos && (
              <label className="fm-search">
                {IC.search}
                <input placeholder="Search for Pools" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search for pools" />
              </label>
            )}
          </div>
          {!pos && (
            <div className="fm-fr">
              <span className="fm-vl">Vaults:</span>
              <CheckDropdown
                right
                options={assets}
                selected={vaultSel}
                onChange={setVaultSel}
                placeholder="Search for vaults"
                withIcons={!lpCat}
                trigger={(open, toggle) => (
                  <button type="button" className={`fm-all ${vaultSel.length ? "set" : ""}`} aria-haspopup="listbox" aria-expanded={open} onClick={toggle}>
                    <FilterIcon />
                    {vaultSel.length ? vaultSel.join(", ") : "All"}
                  </button>
                )}
              />
              <span className="fm-ddw" ref={thrRef}>
                <button type="button" className="fm-chip" aria-haspopup="dialog" aria-expanded={thrOpen} onClick={() => setThrOpen((o) => !o)}>
                  {thrName} <span>{thrLbl}</span>
                </button>
                {thrOpen && (
                  <div className="pop r fm-tpop" role="dialog" aria-label={`${thrName} filter`}>
                    <div className="fm-tph">
                      <span>{thrName}, USD</span>
                      <button
                        type="button"
                        className="fm-reset"
                        onClick={() => {
                          setThr("");
                          setOp("gt");
                        }}
                      >
                        Reset
                      </button>
                    </div>
                    <div className="fm-seg2">
                      <button type="button" className={op === "gt" ? "on" : ""} onClick={() => setOp("gt")}>
                        Greater than
                      </button>
                      <button type="button" className={op === "lt" ? "on" : ""} onClick={() => setOp("lt")}>
                        Less than
                      </button>
                    </div>
                    <input
                      className="fm-thr num"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="e.g. 100K"
                      value={thr}
                      onChange={(e) => setThr(e.target.value)}
                      aria-label={`${thrName} in USD`}
                    />
                  </div>
                )}
              </span>
            </div>
          )}
        </div>

        <div className="fm-tw">{body}</div>
      </div>
    </div>
  );
}

function FilterIcon() {
  return (
    <svg width="17" height="12" viewBox="0 0 17 12" aria-hidden="true">
      <path d="M1 1h15M4 6h9M7 11h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
