import { NextRequest, NextResponse } from "next/server";

// Server-side proxy for Blend's testnet faucet ("getAssets") endpoint.
//   GET /api/faucet/blend?userId=<G-address>
// forwards to Blend's own AWS API Gateway endpoint.
//
// Blend's endpoint has no Access-Control-Allow-Origin header for our domain,
// so a direct browser fetch() to it is blocked by CORS — the request lands
// fine (200 OK) but the browser refuses to hand the body to our JS. Routing
// it through our own Next.js API (server-to-server, no CORS involved at all)
// sidesteps that entirely; the response (a signed-transaction XDR string) is
// passed straight through unchanged.

export const runtime = "nodejs";

const BLEND_FAUCET_URL = "https://ewqw4hx7oa.execute-api.us-east-1.amazonaws.com/getAssets";

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json(
      { error: "Missing `userId` query param." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const upstream = await fetch(`${BLEND_FAUCET_URL}?userId=${encodeURIComponent(userId)}`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    const body = await upstream.text();
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Blend faucet returned ${upstream.status}: ${body.slice(0, 200)}` },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    return new NextResponse(body, {
      status: 200,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return NextResponse.json(
      { error: timedOut ? "Blend faucet request timed out." : "Blend faucet is unavailable." },
      { status: 504, headers: { "Cache-Control": "no-store" } },
    );
  }
}
