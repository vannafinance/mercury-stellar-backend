import { hubbleJson } from "@/lib/hubble/respond";
import { liquidationsQuery } from "@/lib/hubble/queries";

export const runtime = "nodejs";

export async function GET() {
  const { query, params } = liquidationsQuery();
  return hubbleJson(query, params);
}
