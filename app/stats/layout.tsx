import { notFound } from "next/navigation";

import { isStatsEnabled } from "@/lib/hubble/gate";

// Server-side gate: 404 the whole /stats subtree unless STATS_ENABLED="true".
// force-dynamic so the flag is evaluated per request, never baked at build.
export const dynamic = "force-dynamic";

export default function StatsLayout({ children }: { children: React.ReactNode }) {
  if (!isStatsEnabled()) notFound();
  return <>{children}</>;
}
