/**
 * Client session auto-approve (Privy embedded wallet silent-sign of MCP XDR).
 *
 * Distinct from MCP Sign Service "enable auto-sign" (server-side caps). The app
 * toggle only promises the client path: whenever a hop returns a signable XDR,
 * auto-approve must submit it without asking the user to re-enable anything.
 *
 * Multi-leg used to break on hop 2+: MCP often returned needs_auto_sign while
 * hop 1 was needs_wallet_sign, and the UI only auto-submitted the latter — so
 * later legs showed the enable-auto-sign gate with auto-approve already on.
 */

/** Stable key so each hop auto-submits once (request_id alone can collide or be missing). */
export function hopAutoSubmitKey(opts: {
  requestId?: string | null;
  op?: string | null;
  amount?: number | string | null;
  asset?: string | null;
  summary?: string | null;
}): string {
  const amt =
    opts.amount != null && opts.amount !== ""
      ? String(opts.amount)
      : "";
  return [
    opts.requestId?.trim() || "req",
    opts.op?.trim() || "op",
    amt,
    (opts.asset || "").toString().toUpperCase(),
    (opts.summary || "pending").slice(0, 80),
  ].join("|");
}

/**
 * Whether the client may silent-sign this response under app auto-approve.
 *
 * - needs_wallet_sign: always (XDR may still be missing — sign path errors cleanly)
 * - needs_auto_sign + signable XDR: yes (older servers / edge paths)
 * - risk **block** only: never auto-submit
 * - risk **needs_confirmation** / allow: still auto-submit — that chip is policy
 *   copy on every staged XDR, not a request for a manual click
 * - after a failed auto-attempt for this hop key: never until a new hop key
 */
export function shouldSessionAutoSubmit(opts: {
  kind?: string | null;
  sessionSigning: boolean;
  riskDecision?: string | null;
  autoSubmitBlocked?: boolean;
  hasSignableXdr?: boolean;
  allowSessionSign?: boolean;
}): boolean {
  if (!opts.sessionSigning) return false;
  if (opts.allowSessionSign === false) return false;
  if (opts.autoSubmitBlocked) return false;
  // "needs_confirmation" is the normal staged risk label — do NOT treat as click gate.
  if (opts.riskDecision === "block") return false;
  if (opts.kind === "needs_wallet_sign") return true;
  if (opts.kind === "needs_auto_sign" && opts.hasSignableXdr) return true;
  return false;
}

/**
 * Promote needs_auto_sign → needs_wallet_sign when an XDR is present so the
 * existing staged + auto-submit path runs (no enable-auto-sign panel).
 */
export function promoteSignableAutoSignResponse<
  T extends {
    kind: string;
    unsigned_xdr?: string | null;
    preview?: {
      requires_signature?: boolean;
      risk?: { decision?: string; reasons?: string[] } | null;
      [k: string]: unknown;
    } | null;
  },
>(res: T, hasSignableXdr: boolean): T {
  if (res.kind !== "needs_auto_sign" || !hasSignableXdr) return res;
  const preview = res.preview
    ? {
        ...res.preview,
        requires_signature: true,
        risk: res.preview.risk ?? {
          decision: "needs_confirmation",
          reasons: ["wallet sign required (MCP built XDR)"],
        },
      }
    : res.preview;
  return {
    ...res,
    kind: "needs_wallet_sign",
    preview,
  };
}
