import type { ReactNode } from "react";

/**
 * Page title for the older analytics tools (Risk Explorer scenarios, advanced positions), drawn with the
 * V3 analytics shell's `an-view-head` style so they read like the rest of the section.
 */
export function PageHeader({
  title,
  subtitle,
  meta,
  actions,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  if (!title) return null;
  return (
    <div className={`an-view-head ${className}`}>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      {(meta || actions) && (
        <div className="an-row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          {meta}
          {actions}
        </div>
      )}
    </div>
  );
}

/** Timestamp line + optional mock-data pill for dashboard pages */
export function PageHeaderMeta({
  timeLabel,
  mock = true,
}: {
  timeLabel: string;
  mock?: boolean;
}) {
  return (
    <>
      <span className="an-muted" style={{ fontSize: 12 }}>
        As of {timeLabel}
      </span>
      {mock ? <span className="an-badge an-warn">Mock data</span> : null}
    </>
  );
}
