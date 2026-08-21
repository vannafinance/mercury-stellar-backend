/**
 * Short chat copy for on-chain writes.
 *
 * MCP / Sign Service often return a single paragraph with the full tx hash,
 * explorer URL, and C-address. The Copilot UI already shows hash + Expert link
 * in dedicated rows — repeating them in `message` / `human_summary` makes every
 * prompt look like a wall of text (and often duplicates the same blob twice).
 */

import { stroopsToAmountString } from "@/lib/utils/swap-amount";

export function cleanExecutionCopy(opts: {
  /** Step label, e.g. "Borrow 5 XLM". */
  label: string;
  status?: string | null;
  rawMessage?: string | null;
  txHash?: string | null;
}): { headline: string; body: string } {
  const headline = (opts.label || "").trim() || "Submitted on-chain";
  const raw = String(opts.rawMessage || "").trim();
  const onChain =
    !!opts.txHash ||
    opts.status === "signed_and_submitted" ||
    opts.status === "done";

  if (!raw || isVerboseSignServiceDump(raw)) {
    return {
      headline,
      body: onChain ? "Signed and submitted on-chain." : "Done.",
    };
  }

  const body = sanitizeExecutionProse(raw);
  if (!body) {
    return {
      headline,
      body: onChain ? "Signed and submitted on-chain." : "Done.",
    };
  }

  return { headline, body };
}

/**
 * Strip auto-sign plumbing out of a message that is heading for the WALLET-SIGN path.
 *
 * Manual signing is the DEFAULT — auto-approve is off for every new user. So on that path
 * "auto-sign did not happen" is not news, it is the setting the user chose, and MCP's
 * explanation of why is a description of a feature they are not using.
 *
 * Reported live on "create a margin account for me" with auto-approve off: the card read
 *
 *   "Could not auto-complete account creation via the Sign Service: This wallet is not
 *    bound to the authenticated user. Run wallet connect again WHILE SIGNED IN, then retry.
 *    The binding is stamped at /wallets/connect/start from the forwarded user assertion, so
 *    a connect performed with only the app's M2M credential — or before sign-in existed —
 *    records no binding.. You can still sign the unsigned_xdr with your own wallet."
 *
 * — an internal endpoint path, a credential model and a doubled full stop, in front of a
 * user whose account creation was about to work perfectly well by signing in their wallet.
 * It reads as a failure, which is why it was reported as "opening an account does not work
 * with auto-approve off". Nothing was broken except the sentence.
 *
 * The detail is not lost: it stays in `data` / `mcp` for debugging, and the bind flow still
 * has its own dedicated prompt for users who actually want auto-sign.
 */
export function stripAutoSignPlumbing(text: string): string {
  let s = String(text || "");
  // The whole "could not auto-sign, here is why" clause, however it is phrased.
  s = s.replace(
    /\b(could not|couldn'?t|unable to)\s+auto[- ]?(complete|sign)[^.]*\.?/gi,
    "",
  );
  s = s.replace(/\bThis wallet is not bound to the authenticated user\.?/gi, "");
  s = s.replace(/\bRun wallet connect again[^.]*\.?/gi, "");
  s = s.replace(/\bThe binding is stamped at[^]*?records no binding\.?\.?/gi, "");
  s = s.replace(/\b(wallet[_ ]not[_ ]bound|missing_user_assertion|invalid_user_assertion)\b/gi, "");
  s = s.replace(/\bfunction_not_allowlisted\b/gi, "");
  // Redundant once the UI is showing an Approve & sign button.
  s = s.replace(/\bYou can still sign the unsigned_xdr with your own wallet\.?/gi, "");
  s = s.replace(/\/wallets\/connect\/\w+/gi, "");
  s = s.replace(/[ \t]+/g, " ").replace(/\s*\.\s*\./g, ".").replace(/\n{3,}/g, "\n\n");
  return s.replace(/^[\s.,;:·\-–—]+/, "").trim();
}

/** True when MCP returned the long Sign Service receipt paragraph. */
export function isVerboseSignServiceDump(text: string): boolean {
  const t = String(text || "");
  if (/Signed and submitted by the Sign Service/i.test(t)) return true;
  if (/View:\s*https?:\/\/stellar\.expert/i.test(t)) return true;
  if (/New smart account:\s*C[A-Z0-9]{50,}/i.test(t) && /Use this C-address/i.test(t))
    return true;
  // Full 64-char hash + explorer URL in one blob → UI already shows both.
  if (/[a-f0-9]{64}/i.test(t) && /stellar\.expert/i.test(t)) return true;
  return false;
}

/**
 * Strip explorer URLs, full hashes, and C-address boilerplate from free text.
 * Keeps short human notes (impact, repay hints) when present.
 */
export function sanitizeExecutionProse(text: string): string {
  let s = String(text || "");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/https?:\/\/stellar\.expert\/\S+/gi, "");
  s = s.replace(/\bView:\s*/gi, "");
  s = s.replace(/\bTx\s+[a-f0-9]{64}\.?/gi, "");
  s = s.replace(/\b[a-f0-9]{64}\b/gi, "");
  s = s.replace(/\bNew smart account:\s*C[A-Z0-9]{55}\.?\s*/gi, "");
  s = s.replace(/\bUse this C-address[^.]*\.?/gi, "");
  s = s.replace(/\bSigned and submitted by the Sign Service\.?\s*/gi, "");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();
  // Leading crumbs only (after stripping a leading "View:" / "Tx …"). Keep
  // trailing periods so short notes like "Repaid from free balance." stay intact.
  s = s.replace(/^[\s.,;:·\-–—]+/, "").trim();
  s = s.replace(/ \./g, ".").replace(/\.{2,}/g, ".");
  // Still a dump? Prefer empty so the caller uses the short default.
  if (s.length > 320) return "";
  return s;
}

/**
 * Sign Service policy dumps stroops (`10000000000`). Show tokens instead.
 */
export function humanizeStroopCounts(text: string, asset?: string | null): string {
  const unit = String(asset || "tokens").trim() || "tokens";
  return String(text || "").replace(/\b(\d{7,})\b/g, (raw) => {
    try {
      return `${stroopsToAmountString(BigInt(raw))} ${unit}`;
    } catch {
      return raw;
    }
  });
}

export function fmtLpAmt(n: number | string | null | undefined): string {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return String(n ?? "");
  if (Number.isInteger(v) || Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  return v.toFixed(4).replace(/\.?0+$/, "");
}

/** `Add 72 XLM + 1.0011 AQUSDC LP` → `Added 72 XLM and 1.0011 AQUSDC in Aquarius`. */
export function farmAddedLine(summary?: string | null): string | null {
  const s = String(summary || "").trim();
  const m = s.match(/Add\s+(.+?)\s+XLM\s+\+\s+(.+?)\s+(AQUSDC|SOUSDC|BLUSDC)/i);
  if (!m) return null;
  const usd = m[3].toUpperCase();
  const where = usd === "SOUSDC" ? "Soroswap" : usd === "BLUSDC" ? "Blend" : "Aquarius";
  return `Added ${m[1]} XLM and ${m[2]} ${usd} in ${where}`;
}

/** `Remove 10 XLM/AQUSDC LP` → `Removed 10 LP from XLM/AQUSDC pool`. */
export function farmRemovedLine(summary?: string | null): string | null {
  const s = String(summary || "").trim();
  const withPair = s.match(
    /Remove(?:d|ing)?\s+([\d.]+)\s+(?:LP\s+(?:from\s+)?)?([A-Z]{2,10}\/[A-Z]{2,10})(?:\s+LP)?/i,
  );
  if (withPair) {
    return `Removed ${withPair[1]} LP from ${withPair[2].toUpperCase()} pool`;
  }
  const amt = s.match(/Remove(?:d|ing)?\s+([\d.]+)\s+LP/i);
  const pair = s.match(/\b(XLM\/(?:AQUSDC|SOUSDC|USDC)|AQUSDC\/XLM|SOUSDC\/XLM)\b/i);
  if (amt && pair) {
    const p = pair[1].toUpperCase().replace("XLM/USDC", "XLM/AQUSDC");
    return `Removed ${amt[1]} LP from ${p} pool`;
  }
  return null;
}

export function farmReceiptLine(...parts: Array<string | null | undefined>): string | null {
  const blob = parts.filter((p) => p != null && String(p).trim()).join(" | ");
  return farmAddedLine(blob) || farmRemovedLine(blob);
}

/**
 * One-line staged/executed title. The MCP receipt paragraph is not a summary.
 * Live: “Deposit 100 AQUSDC in Lending Pool” — not a 6-line dump.
 */
export function shortWriteLabel(opts: {
  op: string;
  amount?: number | null;
  asset?: string | null;
  token_a?: string | null;
  token_b?: string | null;
  venue?: string | null;
}): string {
  const asset = String(opts.asset || "").trim();
  const amt = opts.amount != null && Number.isFinite(Number(opts.amount)) ? String(opts.amount) : "";
  const sized = [amt, asset].filter(Boolean).join(" ");
  const venue = opts.venue ? String(opts.venue) : "";
  switch (opts.op) {
    case "lend":
    case "supply":
      return sized ? `Deposit ${sized} in Lending Pool` : "Deposit in Lending Pool";
    case "borrow":
      return sized ? `Borrow ${sized}` : "Borrow";
    case "repay":
      return sized ? `Repay ${sized}` : "Repay";
    case "deposit_collateral":
      return sized ? `Deposit ${sized} as collateral` : "Deposit collateral";
    case "withdraw_collateral":
      return sized ? `Withdraw ${sized} collateral` : "Withdraw collateral";
    case "deploy_to_blend":
    case "supply_to_blend":
      return sized ? `Supply ${sized} to Blend` : "Supply to Blend";
    case "withdraw_from_blend":
      return sized ? `Withdraw ${sized} from Blend` : "Withdraw from Blend";
    case "add_liquidity": {
      const pair = [opts.token_a, opts.token_b].filter(Boolean).join("/");
      const where = venue ? ` in ${venue}` : "";
      const pretty = amt ? fmtLpAmt(opts.amount) : "";
      const sizedPretty = [pretty, asset].filter(Boolean).join(" ");
      if (sizedPretty && pair) return `Add ${sizedPretty} (${pair}) liquidity${where}`;
      if (sizedPretty) return `Add ${sizedPretty} liquidity${where}`;
      return `Add liquidity${where}`;
    }
    case "remove_liquidity":
      return `${amt ? `Remove ${amt} LP` : "Remove LP"}${venue ? ` from ${venue}` : ""}`;
    case "swap": {
      const out = String(opts.token_b || "").trim();
      return sized && out ? `Swap ${sized} → ${out}` : sized ? `Swap ${sized}` : "Swap";
    }
    default:
      return sized ? `${opts.op.replace(/_/g, " ")} ${sized}` : opts.op.replace(/_/g, " ");
  }
}
