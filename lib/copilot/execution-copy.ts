/**
 * Short chat copy for on-chain writes.
 *
 * MCP / Sign Service often return a single paragraph with the full tx hash,
 * explorer URL, and C-address. The Copilot UI already shows hash + Expert link
 * in dedicated rows — repeating them in `message` / `human_summary` makes every
 * prompt look like a wall of text (and often duplicates the same blob twice).
 */

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
