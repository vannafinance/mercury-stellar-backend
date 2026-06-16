import { hubbleJson } from "@/lib/hubble/respond";
import { tvlQuery } from "@/lib/hubble/queries";

// Node runtime: the BigQuery client depends on Node APIs and cannot run on Edge.
export const runtime = "nodejs";

export async function GET() {
  const { query, params } = tvlQuery();
  return hubbleJson(query, params);
}
