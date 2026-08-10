/**
 * A Sign Service refusal to AUTO-sign is not a failed transaction.
 *
 * Reproduced live on 2026-08-10 with a fresh wallet and auto-approve OFF (the default for
 * every new user): "create a margin account for me" returned `kind: "error"` with
 * `wallet_not_bound`, no Approve & sign button, and MCP's internal plumbing prose — while
 * the transaction MCP had already built sat unused in the very same response
 * (`has_unsigned_xdr: true`).
 *
 * The payloads below are the shapes observed on the wire, including the detail that made
 * it slip through: `auto_sign` and `auto_sign_error` are BOTH null, so the refusal never
 * reached the auto-sign branches and fell into the generic `softFail` error path.
 */
import { describe, expect, it } from "vitest";
import { executeMcpWrite } from "@/lib/copilot/mcp-write";

const XDR = "AAAAAgAAAAA".padEnd(2608, "A");

const fakeMcp = (build: Record<string, unknown>) =>
  ({ call: async () => build }) as unknown as Parameters<typeof executeMcpWrite>[0];

const STEP = { tool: "vanna_open_account", args: { trader: "G".padEnd(56, "A") }, label: "Create smart account" };
const CTX = { userId: "did:privy:test", trader: "G".padEnd(56, "A"), smartAccount: null } as never;

/** The live payload, verbatim in shape. */
const walletNotBound = {
  error: "wallet_not_bound",
  message:
    "Could not auto-complete account creation via the Sign Service: This wallet is not bound " +
    "to the authenticated user. Run wallet connect again WHILE SIGNED IN, then retry. The " +
    "binding is stamped at /wallets/connect/start from the forwarded user assertion, so a " +
    "connect performed with only the app's M2M credential — or before sign-in existed — " +
    "records no binding.. You can still sign the unsigned_xdr with your own wallet.",
  unsigned_xdr: XDR,
  auto_sign: null,
  auto_sign_error: null,
};

describe("executeMcpWrite — an auto-sign refusal with a usable XDR stages for the wallet", () => {
  it("wallet_not_bound + XDR → needs_wallet_sign, not error", async () => {
    const r = await executeMcpWrite(fakeMcp(walletNotBound), STEP, CTX);
    expect(r.status).toBe("needs_wallet_sign");
    expect(r.unsigned_xdr).toBe(XDR);
  });

  it("keeps MCP's internal plumbing prose out of the user-facing message", async () => {
    const r = await executeMcpWrite(fakeMcp(walletNotBound), STEP, CTX);
    expect(r.message).not.toMatch(/wallet_not_bound/i);
    expect(r.message).not.toMatch(/\/wallets\/connect\//i);
    expect(r.message).not.toMatch(/M2M/i);
    expect(r.message).not.toMatch(/unsigned_xdr/i);
    // Doubled full stop from MCP's own string concatenation.
    expect(r.message).not.toMatch(/\.\./);
  });

  it("the diagnostic survives in the trace for debugging, just not in the copy", async () => {
    const r = await executeMcpWrite(fakeMcp(walletNotBound), STEP, CTX);
    expect(String(r.mcp_trace.auto_sign_error)).toMatch(/wallet_not_bound/i);
  });

  it("the same refusal with NO XDR is still an error — nothing is invented", async () => {
    const r = await executeMcpWrite(
      fakeMcp({ ...walletNotBound, unsigned_xdr: undefined }),
      STEP,
      CTX,
    );
    expect(r.status).not.toBe("needs_wallet_sign");
    expect(r.unsigned_xdr ?? null).toBeNull();
  });

  /**
   * The guard is deliberately keyed on the error CODE. A real simulation failure that
   * happens to return an envelope must still be reported, never quietly offered for
   * signature — signing an unsimulated envelope is the one thing this path must not do.
   */
  it("a genuine simulation failure is not re-routed to the wallet", async () => {
    const r = await executeMcpWrite(
      fakeMcp({
        error: "simulation_failed",
        message: "Simulation failed: insufficient balance",
        unsigned_xdr: XDR,
      }),
      STEP,
      CTX,
    );
    expect(r.status).not.toBe("needs_wallet_sign");
  });

  it("no_active_session with an XDR also stages rather than erroring", async () => {
    const r = await executeMcpWrite(
      fakeMcp({ error: "no_active_session", message: "auto-sign is not enabled", unsigned_xdr: XDR }),
      STEP,
      CTX,
    );
    expect(r.status).toBe("needs_wallet_sign");
    expect(r.unsigned_xdr).toBe(XDR);
  });
});
