// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { preserveWalletBindPanelResponse } from "@/components/copilot/copilot-workspace";

const requestId = "req-bind-panel";
const connectUrl = "connect-url-for-this-request";

describe("wallet-bind panel response continuity", () => {
  it("keeps a terminal reason and its fallback link when a later poll is pending", () => {
    const unavailable = {
      kind: "needs_wallet_bind" as const,
      message: "Vanna could not finish authorizing this wallet.",
      request_id: requestId,
      wallet_bind: {
        status: "unavailable" as const,
        request_id: requestId,
        connect_url: connectUrl,
      },
    };
    const pending = {
      kind: "needs_wallet_bind" as const,
      message: "Still waiting for the user to approve.",
      wallet_bind: { status: "pending" as const, request_id: requestId },
    };

    const preserved = preserveWalletBindPanelResponse(unavailable, pending);

    expect(preserved.message).toBe(unavailable.message);
    expect(preserved.wallet_bind?.status).toBe("unavailable");
    expect(preserved.wallet_bind?.connect_url).toBe(connectUrl);
  });

  it("carries the connect link from consent into an ordinary pending poll", () => {
    const consent = {
      kind: "needs_wallet_bind" as const,
      message: "Authorize the additional signer.",
      wallet_bind: {
        status: "needs_consent" as const,
        request_id: requestId,
        connect_url: connectUrl,
        signer_id: "signer-id",
      },
    };
    const pending = {
      kind: "needs_wallet_bind" as const,
      message: "Still waiting for the user to approve.",
      wallet_bind: { status: "pending" as const, request_id: requestId },
    };

    const preserved = preserveWalletBindPanelResponse(consent, pending);

    expect(preserved.message).toBe(pending.message);
    expect(preserved.wallet_bind?.status).toBe("pending");
    expect(preserved.wallet_bind?.connect_url).toBe(connectUrl);
    expect(preserved.wallet_bind?.signer_id).toBe("signer-id");
  });
});
