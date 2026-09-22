import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWalletBind, rememberConnectOrigin } from "@/lib/copilot/wallet-bind";

/**
 * A 200 from register is not a binding.
 *
 * `/wallets/connect/register` answers `{status:'ok', connected:true}` whether or not it
 * wrote the `identity_wallet_bindings` row, and this function used to return a bare
 * `{ok:true}` on any 2xx — so the one fact the caller needed was discarded at the only
 * hop that could see it. Callers reported success while every consumer downstream still
 * refused the wallet as unbound, and nothing in the product could tell the difference.
 *
 * What is pinned here is that the OUTCOME is read from the response rather than inferred
 * from the status, including the case of a Sign Service too old to report it — which must
 * stay distinguishable from a reported failure, or a caller retrying on `false` would spin
 * forever against a deployment that simply cannot answer.
 */

const ORIGIN = "https://gateway.test";
const REQUEST_ID = "req-outcome";

function respondWith(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("registerWalletBind reports what the service actually did", () => {
  it("reports a written binding", async () => {
    rememberConnectOrigin(REQUEST_ID, `${ORIGIN}/connect`);
    respondWith({ status: "ok", connected: true, identity_binding_written: true });

    const result = await registerWalletBind({
      requestId: REQUEST_ID,
      walletAddress: "GBOUND",
      origin: ORIGIN,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bindingWritten).toBe(true);
  });

  it("does not report success as a binding when the service says none was written", async () => {
    respondWith({
      status: "ok",
      connected: true,
      identity_binding_written: false,
      identity_binding_error: "binding_write_failed",
    });

    const result = await registerWalletBind({
      requestId: REQUEST_ID,
      walletAddress: "GBOUND",
      origin: ORIGIN,
    });

    // The call succeeded — the binding did not. Collapsing these is the original defect.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bindingWritten).toBe(false);
      expect(result.bindingError).toBe("binding_write_failed");
    }
  });

  it("says 'unknown', not 'no', when the service does not report the field", async () => {
    respondWith({ status: "ok", connected: true });

    const result = await registerWalletBind({
      requestId: REQUEST_ID,
      walletAddress: "GBOUND",
      origin: ORIGIN,
    });

    expect(result.ok).toBe(true);
    // null, never false: an absence of evidence is not evidence of failure.
    if (result.ok) expect(result.bindingWritten).toBeNull();
  });

  it("still surfaces a refusal as a refusal", async () => {
    respondWith({ error: "wallet_mismatch", message: "not your wallet" }, 403);

    const result = await registerWalletBind({
      requestId: REQUEST_ID,
      walletAddress: "GOTHER",
      origin: ORIGIN,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("wallet_mismatch");
      expect(result.expired).toBe(false);
    }
  });
});
