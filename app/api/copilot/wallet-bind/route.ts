/**
 * Attach the Vanna signer and bind the wallet — as its own thing, not as a side effect.
 *
 * ## Why this route exists
 *
 * `identity_wallet_bindings` had exactly one trigger in this app: turning auto-sign ON.
 * The three steps that write it (connect/start → Privy `addSigners` → connect/register)
 * were only ever reached through `req.auto_sign` in handle-autosign.ts. But those are two
 * different permissions on two different timelines:
 *
 *   - the Vanna signer being attached to the wallet, which is what makes the wallet usable
 *     by the protocol at all, and belongs to connecting;
 *   - auto-approve, which is a per-session signing policy the user flips whenever.
 *
 * Coupling them meant a user with auto-approve OFF could never be bound, so every turn —
 * reads included — came back "I couldn't verify the wallet link this turn", with no action
 * available anywhere in the product that would fix it. Enabling auto-sign was the only
 * cure, which is precisely the permission that user had declined.
 *
 * So the bind gets its own endpoint, with no auto-sign semantics attached: no retry
 * action, no session enable, no policy. The client runs it on connect. Whether the user
 * later wants auto-approve is a separate, unrelated decision.
 *
 * ## What it does not change
 *
 * Nothing here is trusted and nothing here is new authority. `start` still carries the
 * end-user assertion, so the Sign Service stamps the same `sub` it always did. `register`
 * still makes the Sign Service re-verify quorum-is-signer against Privy before it writes.
 * A caller that lies about having authorized gets the same refusal it would have got
 * through the auto-sign path.
 */

import { NextRequest, NextResponse } from "next/server";
import { getMcpClient } from "@/lib/copilot/mcp-client";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { withBoundUser } from "@/lib/copilot/user-context";
import {
  registerWalletBind,
  rememberConnectOrigin,
  resolveConnectOrigin,
  resolvePrivySignerId,
} from "@/lib/copilot/wallet-bind";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A refusal the client can act on, never an exception it has to parse out of prose. */
function refuse(reason: string, status = 200) {
  return NextResponse.json({ ok: false, reason }, { status });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return refuse("invalid_body", 400);
  }

  const action = typeof body.action === "string" ? body.action : "";

  // The binding is keyed on the verified subject, so an unauthenticated caller has
  // nothing to bind. This is the same gate every other identity-bearing route applies.
  const loaded = await loadUserFromRequest(req);
  const bound = loaded.bound;
  if (!bound?.sub) return refuse("not_authenticated");

  if (action === "start") {
    let started: Record<string, unknown>;
    try {
      started = await withBoundUser(bound, () =>
        getMcpClient().call("vanna_connect_wallet_start", {}, bound.sub),
      );
    } catch (e) {
      return refuse(`start_failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const connectUrl = typeof started.connect_url === "string" ? started.connect_url : null;
    const requestId = typeof started.request_id === "string" ? started.request_id : null;
    if (!connectUrl || !requestId || started.error) {
      return refuse(String(started.message || started.error || "no_connect_url"));
    }

    // Record where this request was minted so `register` can complete it without ever
    // being handed a forward target by the browser (see wallet-bind.ts's docstring).
    rememberConnectOrigin(requestId, connectUrl);
    const origin = resolveConnectOrigin(requestId);
    const signerId = origin ? await resolvePrivySignerId(origin) : null;
    // Without a signer id the page cannot authorize anything, and guessing which quorum
    // to grant is exactly the mistake this must not make.
    if (!signerId) return refuse("no_signer_id");

    return NextResponse.json({ ok: true, request_id: requestId, signer_id: signerId });
  }

  if (action === "register") {
    const requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
    const walletAddress =
      typeof body.wallet_address === "string" ? body.wallet_address.trim() : "";
    if (!requestId || !walletAddress) return refuse("missing_request_or_wallet", 400);

    const origin = resolveConnectOrigin(requestId);
    if (!origin) return refuse("origin_expired");

    const result = await registerWalletBind({ requestId, walletAddress, origin });
    if (!result.ok) {
      return NextResponse.json({ ok: false, reason: result.code, expired: result.expired });
    }
    // `bound` reports what the Sign Service actually wrote, not merely that the call
    // succeeded — the distinction this whole flow exists to stop losing.
    return NextResponse.json({
      ok: true,
      bound: result.bindingWritten,
      ...(result.bindingError ? { reason: result.bindingError } : {}),
    });
  }

  return refuse("unknown_action", 400);
}
