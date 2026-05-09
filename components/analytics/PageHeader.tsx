import type { ReactNode } from "react";

export function PageHeader(_props: {
  title?: string;
  subtitle?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return null;
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
      <span className="text-xs text-vgray-500 tabular-nums">
        As of {timeLabel}
      </span>
      {mock ? (
        <span className="inline-flex items-center rounded-full border border-vgray-200 bg-vgray-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-vgray-500">
          Mock data
        </span>
      ) : null}
    </>
  );
}
