import { hubbleJson } from "@/lib/hubble/respond";
import { volumeQuery } from "@/lib/hubble/queries";

export const runtime = "nodejs";

export async function GET() {
  const { query, params } = volumeQuery();
  return hubbleJson(query, params);
}
