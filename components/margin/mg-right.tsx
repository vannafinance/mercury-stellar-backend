"use client";

/**
 * Right column of the V3 Margin screen: Margin Account Info, the Liquidation card (health factor +
 * meter + dollar buffer to the 1.10 line) and the "Oracles and LTs" collapsible (the on-chain
 * oracle, liquidation threshold and RiskEngine contracts, plus each asset's oracle price).
 *
 * Account numbers come from the RiskEngine-exact model (`useV3Account`); the borrow rate from the
 * account snapshot; prices from the on-chain oracle (`useTokenPrices`; the venue USDC wrappers
 * BLUSDC / AQUSDC / SOUSDC are priced off USDC).
 */
import { useState } from "react";
import toast from "react-hot-toast";
import { Icon, IC, VMark } from "@/components/v3/icons";
import { hfFmt, hfLabel, nf, pct, price as pxFmt, usd } from "@/components/v3/format";
import { LIQ_HF, hfPos, hfZone } from "@/lib/account-model";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import { liqBuffer, noDebt } from "./mg-sim";
import { LblTip, MI, TIPS } from "./mg-ui";
import { explorerContract, type MarginScreen } from "./use-margin-screen";

const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-6)}`;

function Addr({ value }: { value: string }) {
  return (
    <span className="mg-addr">
      <span>{short(value)}</span>
      <button
        type="button"
        aria-label="Copy address"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => toast.success("Address copied"));
        }}
      >
        {MI.copy}
      </button>
      <a href={explorerContract(value)} target="_blank" rel="noopener noreferrer" aria-label="Open in Stellar Expert">
        {IC.ext}
      </a>
    </span>
  );
}

/** Assets with an oracle row: [display symbol, note]. */
const ORACLE_ROWS: [string, string][] = [
  ["XLM", "Oracle"],
  ["USDC", "Oracle"],
  ["BLUSDC", "via USDC"],
  ["AQUSDC", "via USDC"],
  ["SOUSDC", "via USDC"],
];

export function RightColumn({ m }: { m: MarginScreen }) {
  const [orc, setOrc] = useState(false);
  const n = m.now;
  const nd = noDebt(n);
  const on = m.connected && m.hasAccount;
  const empty = !(n.holdings > 0.01) && nd;

  const rows: [string, React.ReactNode, string][] = on
    ? [
        ["Total Borrowed value", usd(n.debt), TIPS.borrowed],
        ["Net Available Collateral", usd(n.equity), TIPS.equity],
        ["Total Value", usd(n.holdings), TIPS.value],
        ["Net Health Factor", <span key="hf" className={nd ? "z-ok" : hfZone(n.hf)}>{hfFmt(n.hf)}</span>, TIPS.hf],
        ["Net Borrow Rate", pct(nd ? 0 : m.borrowRate), TIPS.rate],
      ]
    : [
        ["Total Borrowed value", "$0.00", TIPS.borrowed],
        ["Net Available Collateral", "$0.00", TIPS.equity],
        ["Total Value", "$0.00", TIPS.value],
        ["Net Health Factor", "No debt", TIPS.hf],
        ["Net Borrow Rate", "0.00%", TIPS.rate],
      ];

  return (
    <>
      <header className="mg-rh">
        <span className="mg-rh-ic">
          <VMark size={22} />
        </span>
        <div>
          <h2>Margin Account Info</h2>
          <p>Stay updated details and status.</p>
        </div>
      </header>
      <article className="mg-ic">
        {rows.map(([k, v, t]) => (
          <div key={k} className="mg-ir">
            <span>
              <LblTip k={k} tip={t} />
            </span>
            <span className="num">{v}</span>
          </div>
        ))}
      </article>
      {on && !empty && <LiquidationCard m={m} />}
      <article className="mg-ic">
        <button type="button" className="mg-exh" aria-expanded={orc} onClick={() => setOrc((v) => !v)}>
          Oracles and LTs{MI.chev13}
        </button>
        {orc && (
          <div className="mg-exb">
            <div className="mg-ir">
              <span>Oracle Contract</span>
              <span>
                <Addr value={CONTRACT_ADDRESSES.ORACLE} />
              </span>
            </div>
            <div className="mg-ir">
              <span>
                <LblTip
                  k="Liquidation Threshold"
                  tip="The account can be liquidated when its health factor is at or below 1.10. The health factor is unweighted: every asset counts at its full oracle value (no per-asset collateral weights)."
                />
              </span>
              <span className="num">{nf(LIQ_HF, 2)}x</span>
            </div>
            <div className="mg-ir">
              <span>Risk Engine</span>
              <span>
                <Addr value={CONTRACT_ADDRESSES.RISK_ENGINE} />
              </span>
            </div>
            {ORACLE_ROWS.map(([s, note]) => {
              const p = m.px(s);
              return (
                <div key={s} className="mg-ir">
                  <span>
                    <Icon sym={s} />
                    {s}
                    <small>{note}</small>
                  </span>
                  <span className="num">{p > 0 ? `$${pxFmt(p)}` : usd(0)}</span>
                </div>
              );
            })}
          </div>
        )}
      </article>
    </>
  );
}

/**
 * HF + meter, with the 1.10 tick and the dollar buffer showing the distance to liquidation.
 */
function LiquidationCard({ m }: { m: MarginScreen }) {
  const n = m.now;
  const r = m.acct.room;
  const nd = !r || r.state === "nodebt";
  const head = (
    <div className="mg-lq-h">
      <h3>
        <LblTip k="Liquidation" tip={TIPS.hf} />
      </h3>
      {nd ? <span className="mg-zp z-ok">No debt</span> : <span className={`mg-zp ${hfZone(n.hf)}`}>{hfLabel(n.hf)}</span>}
    </div>
  );
  if (nd) {
    return <article className="mg-ic mg-lq">{head}</article>;
  }
  const tick = hfPos(LIQ_HF);
  return (
    <article className="mg-ic mg-lq">
      {head}
      <div className="mg-lq-hf">
        <b className={`num ${hfZone(n.hf)}`}>{hfFmt(n.hf)}</b>
        <span>
          Liquidation at {nf(LIQ_HF, 2)} · buffer {usd(liqBuffer(n))}
        </span>
      </div>
      <div className="mg-lq-bar">
        <div className="hfbar">
          <i style={{ left: `${hfPos(n.hf)}%` }} />
        </div>
        <div className="mg-lq-tk">
          <i style={{ left: `${tick}%` }} />
          <span className="c" style={{ left: `${tick}%` }}>
            {nf(LIQ_HF, 2)}
          </span>
          <span style={{ right: 0 }}>2.50+</span>
        </div>
      </div>
    </article>
  );
}
