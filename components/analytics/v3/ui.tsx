"use client";

/**
 * Presentation primitives for the Risk Analytics screens (styled by analytics.css), ported from the
 * Solana analytics. Pure presentation: they receive finished values and never fetch or compute
 * financial figures.
 */
import { useState, type ReactNode } from "react";
import { logoSrc } from "@/components/v3/icons";
import { definitions, type DefinitionKey } from "@/lib/analytics/v3/definitions";
import { lineName, STATUS_LABEL, type AccountRow, type AccountStatus } from "@/lib/analytics/v3/model";
import { short, when } from "@/lib/analytics/v3/format";
import { useYou } from "./data";

const PATHS: Record<string, string> = {
  overview: "M12 5a8 8 0 100 16 8 8 0 000-16zM12 8.5V13l3 2M5 4L3 6M19 4l2 2",
  liquidations: "M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.5 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z",
  accounts: "M12 4.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zM4 21c.7-4 3.8-6 8-6s7.3 2 8 6",
  pools: "M3 8l9-5 9 5-9 5zM3 12.5l9 5 9-5M3 17l9 5 9-5",
  collateral: "M12 3l8 3v6c0 4.5-3.2 7.6-8 9-4.8-1.4-8-4.5-8-9V6zM9 12l2 2 4-4",
  prices: "M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17zM12 9a3 3 0 100 6 3 3 0 000-6zM12 2v4M12 18v4M2 12h4M18 12h4",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  products: "M9 3v4M15 3v4M7 7h10v5a5 5 0 01-10 0zM12 17v4",
  calculator: "M7.5 3h9A2.5 2.5 0 0119 5.5v13a2.5 2.5 0 01-2.5 2.5h-9A2.5 2.5 0 015 18.5v-13A2.5 2.5 0 017.5 3zM8.5 7.5h7M8.5 12h2M13.5 12h2M8.5 16h2M13.5 16h2",
  health: "M3 17l6-6 4 4 8-8M15 7h6v6",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  arrow: "M5 12h14M13 6l6 6-6 6",
  search: "M10.5 4a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM15.5 15.5L21 21",
  info: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.5h.01",
  warning: "M12 3.5L2.5 20h19zM12 10v5M12 17.5h.01",
  check: "M4 12.5l5 5L20 6.5",
  chevron: "M9 5l7 7-7 7",
  alerts: "M12 3a6 6 0 00-6 6c0 5-2 6-2 6h16s-2-1-2-6a6 6 0 00-6-6zM10 19a2 2 0 004 0",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  copy: "M8 8h10a2 2 0 012 2v10a2 2 0 01-2 2H8a2 2 0 01-2-2V10a2 2 0 012-2zM16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2",
};

export function Icon({ name, className }: { name: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}

/** Hover/keyboard-focus tooltip trigger. The text is shown by the shell's TooltipHost. */
export function InfoTip({ k }: { k: DefinitionKey }) {
  const [title, body] = definitions[k];
  return (
    <span className="an-info an-info-btn" tabIndex={0} role="img" aria-label={`${title}: ${body}`} data-tip-title={title} data-tip={body}>
      <Icon name="info" className="an-info-icon" />
    </span>
  );
}

export type Tone = "ok" | "warn" | "critical" | "danger" | "accent" | "neutral" | "";

export function Badge({ children, tone = "" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`an-badge ${tone ? `an-${tone}` : ""}`}>{children}</span>;
}

const TONE: Record<AccountStatus, Tone> = { empty: "ok", nodebt: "ok", healthy: "ok", warning: "warn", critical: "warn", liquidatable: "danger" };
const DESC: Record<AccountStatus, string> = {
  empty: "The account has no collateral and no debt.",
  nodebt: "The account holds collateral but owes nothing, so it cannot be liquidated.",
  healthy: "Collateral is worth well over what is owed.",
  warning: "A price drop could make this account liquidatable.",
  critical: "A price drop could make this account liquidatable.",
  liquidatable: "Health is at or below the liquidation line. A liquidator can close this position now.",
};
export const statusTone = (s: AccountStatus): Tone => TONE[s];

/** Status badge with a hover explanation. */
export function StatusBadge({ row }: { row: Pick<AccountRow, "status"> }) {
  return (
    <span data-tip={DESC[row.status]} tabIndex={0}>
      <Badge tone={TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
    </span>
  );
}

export function Kpi({ label, value, sub, tone = "", tip, badge, na = false, accent = false }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; tip?: DefinitionKey; badge?: ReactNode; na?: boolean; accent?: boolean;
}) {
  return (
    <div className={`an-kpi ${accent ? "an-accent-edge" : ""}`}>
      <span className="an-kpi-label">
        <span className="an-kpi-label-text" title={label}>{label}</span>
        {tip && <InfoTip k={tip} />}
        {badge}
      </span>
      <span className={`an-kpi-value ${na ? "an-na" : tone ? `an-${tone}` : ""}`}>{value}</span>
      <span className="an-kpi-sub">{sub}</span>
    </div>
  );
}

export function Panel({ title, sub, tip, actions, children, flush = false, className = "", foot, id }: {
  title: string; sub?: ReactNode; tip?: DefinitionKey; actions?: ReactNode; children?: ReactNode; flush?: boolean; className?: string; foot?: ReactNode; id?: string;
}) {
  return (
    <section className={`an-panel ${flush ? "an-flush" : ""} ${className}`} id={id}>
      <div className="an-panel-head">
        <div>
          <h2 className="an-panel-title">{title}{tip && <InfoTip k={tip} />}</h2>
          {sub && <p className="an-panel-sub">{sub}</p>}
        </div>
        {actions && <div className="an-row">{actions}</div>}
      </div>
      {children}
      {foot && <p className="an-panel-foot">{foot}</p>}
    </section>
  );
}

export function Empty({ title, text, icon = "activity", children }: { title: string; text?: ReactNode; icon?: string; children?: ReactNode }) {
  return (
    <div className="an-empty">
      <div className="an-empty-icon"><Icon name={icon} /></div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {children}
    </div>
  );
}

export function Notice({ children, tone = "" }: { children: ReactNode; tone?: "warn" | "danger" | "" }) {
  return (
    <div className={`an-notice ${tone ? `an-${tone}` : ""}`} role="note">
      <Icon name={tone ? "warning" : "info"} />
      <div>{children}</div>
    </div>
  );
}

// ---- assets ---------------------------------------------------------------------------------------
const NAMES: Record<string, string> = {
  XLM: "Stellar Lumens", USDC: "USD Coin", BLUSDC: "Blend USDC", AQUSDC: "Aquarius USDC", SOUSDC: "Soroswap USDC",
  BLND: "Blend", AQUA: "Aquarius", WETH: "Wrapped Ether", EURC: "Euro Coin",
};

/** The logo a symbol shows: Blend deposits show their underlying; LP positions show their venue. */
function tokenIcon(symbol: string): string | null {
  const u = symbol.toUpperCase();
  if (u.startsWith("BLEND_")) return logoSrc(u.slice(6));
  if (u.startsWith("AQ_")) return logoSrc("AQUARIUS");
  if (u.startsWith("SS_")) return logoSrc("SOROSWAP");
  return logoSrc(symbol);
}

export function TokenImg({ symbol, size = 28 }: { symbol: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const src = tokenIcon(symbol);
  if (!src || failed) return <span className="an-ph" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}>{symbol.slice(0, 2)}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" width={size} height={size} onError={() => setFailed(true)} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }} />;
}

export function AssetCell({ symbol, sub, size = "" }: { symbol: string; sub?: string; size?: "sm" | "" }) {
  const name = sub ?? (NAMES[symbol] || lineName(symbol));
  return (
    <span className={`an-asset ${size ? `an-${size}` : ""}`}>
      <TokenImg symbol={symbol} size={size === "sm" ? 20 : 28} />
      <span><b>{symbol}</b>{name && <span>{name}</span>}</span>
    </span>
  );
}

export function AssetStack({ symbols }: { symbols: string[] }) {
  return (
    <span className="an-asset-stack">
      {symbols.slice(0, 4).map((s) => <span key={s} data-tip={s}><TokenImg symbol={s} size={22} /></span>)}
      {symbols.length > 4 && <span className="an-ph">+{symbols.length - 4}</span>}
    </span>
  );
}

/** "YOU" next to the connected wallet (or its margin account address), wherever it appears. */
export function YouPill({ value }: { value?: string | null }) {
  const { wallet, margin } = useYou();
  return value && (value === wallet || value === margin) ? <span className="an-you-pill">YOU</span> : null;
}

export function Addr({ value, head = 5, tail = 5 }: { value: string; head?: number; tail?: number }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="an-muted">-</span>;
  return (
    <span className="an-addr" title={value}>
      {short(value, head, tail)}
      <button type="button" aria-label="Copy address" onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
      }}>{copied ? "Copied" : "Copy"}</button>
    </span>
  );
}

/** A ledger close time (wall-clock ms). */
export function When({ t }: { t: number | null | undefined }) {
  return <span>{when(t)}</span>;
}
