import { hubbleJson } from "@/lib/hubble/respond";
import { topBorrowersQuery } from "@/lib/hubble/queries";

export const runtime = "nodejs";

export async function GET() {
  const { query, params } = topBorrowersQuery();
  return hubbleJson(query, params);
}
