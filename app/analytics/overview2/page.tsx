import { OverviewView } from "@/components/analytics/v3/views/overview";

/**
 * The former "Overview V2" URL (still linked from the site header). Its live content - the risk KPIs, the
 * all-positions monitor, the health / composition charts and the stress-testing hub - now lives in the V3
 * Overview (leverage distribution on Positions, scenarios on Risk Explorer), so this route renders it.
 */
export default function Overview2Page() {
  return <OverviewView />;
}
