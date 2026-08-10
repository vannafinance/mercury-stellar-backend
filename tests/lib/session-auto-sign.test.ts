/**
 * App auto-approve = client session sign of MCP XDR on every hop.
 * Must not re-open Sign Service "enable auto-sign" when XDR is already present.
 */

import { describe, expect, it } from "vitest";
import {
  hopAutoSubmitKey,
  promoteSignableAutoSignResponse,
  shouldSessionAutoSubmit,
} from "@/components/copilot/session-auto-sign";

describe("hopAutoSubmitKey", () => {
  it("differs per leg so hop 2 is not skipped after hop 1", () => {
    const hop1 = hopAutoSubmitKey({
      requestId: "r1",
      op: "deposit_collateral",
      amount: 10,
      asset: "BLUSDC",
      summary: "Deposit 10 BLUSDC",
    });
    const hop2 = hopAutoSubmitKey({
      requestId: "r2",
      op: "borrow",
      amount: 10,
      asset: "BLUSDC",
      summary: "Borrow 10 BLUSDC",
    });
    expect(hop1).not.toBe(hop2);
  });

  it("stays stable for the same hop (no double auto-submit)", () => {
    const a = hopAutoSubmitKey({
      requestId: "same",
      op: "supply_to_blend",
      amount: 9.965,
      asset: "BLUSDC",
    });
    const b = hopAutoSubmitKey({
      requestId: "same",
      op: "supply_to_blend",
      amount: 9.965,
      asset: "BLUSDC",
    });
    expect(a).toBe(b);
  });
});

describe("shouldSessionAutoSubmit", () => {
  it("auto-submits needs_wallet_sign when session signing is on", () => {
    expect(
      shouldSessionAutoSubmit({
        kind: "needs_wallet_sign",
        sessionSigning: true,
        riskDecision: "needs_confirmation",
      }),
    ).toBe(true);
  });

  it("needs_confirmation is NOT a click gate (staged borrow after deposit)", () => {
    // Live: risk chip said "confirm" and UI claimed "risk gate flagged — needs your
    // click" while auto-approve was on. Confirmation is normal staged copy.
    expect(
      shouldSessionAutoSubmit({
        kind: "needs_wallet_sign",
        sessionSigning: true,
        riskDecision: "needs_confirmation",
        autoSubmitBlocked: false,
        hasSignableXdr: true,
      }),
    ).toBe(true);
  });

  it("does NOT re-prompt for enable when needs_auto_sign has XDR", () => {
    // The live multi-leg bug: hop 2 came back needs_auto_sign while hop 1 was
    // needs_wallet_sign — auto-approve was on but only the first kind auto-fired.
    expect(
      shouldSessionAutoSubmit({
        kind: "needs_auto_sign",
        sessionSigning: true,
        riskDecision: "needs_confirmation",
        hasSignableXdr: true,
      }),
    ).toBe(true);
  });

  it("needs_auto_sign without XDR cannot session-sign", () => {
    expect(
      shouldSessionAutoSubmit({
        kind: "needs_auto_sign",
        sessionSigning: true,
        hasSignableXdr: false,
      }),
    ).toBe(false);
  });

  it("respects risk block and failed-attempt block", () => {
    expect(
      shouldSessionAutoSubmit({
        kind: "needs_wallet_sign",
        sessionSigning: true,
        riskDecision: "block",
      }),
    ).toBe(false);
    expect(
      shouldSessionAutoSubmit({
        kind: "needs_wallet_sign",
        sessionSigning: true,
        autoSubmitBlocked: true,
      }),
    ).toBe(false);
  });

  it("off when auto-approve / session signing is off", () => {
    expect(
      shouldSessionAutoSubmit({
        kind: "needs_wallet_sign",
        sessionSigning: false,
      }),
    ).toBe(false);
  });
});

describe("promoteSignableAutoSignResponse", () => {
  it("promotes needs_auto_sign + XDR to needs_wallet_sign", () => {
    const out = promoteSignableAutoSignResponse(
      {
        kind: "needs_auto_sign",
        unsigned_xdr: "AAAA...long...",
        preview: {
          human_summary: "Borrow 10 BLUSDC",
          requires_signature: false,
        },
      },
      true,
    );
    expect(out.kind).toBe("needs_wallet_sign");
    expect(out.preview?.requires_signature).toBe(true);
  });

  it("leaves true enable-gate (no XDR) alone", () => {
    const raw = {
      kind: "needs_auto_sign" as const,
      unsigned_xdr: null as string | null,
      preview: { human_summary: "Enable" },
    };
    expect(promoteSignableAutoSignResponse(raw, false)).toEqual(raw);
  });
});
