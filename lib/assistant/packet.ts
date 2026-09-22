/**
 * Assistant request packet — shared bounds and sanitizers for the browser
 * send path and POST /api/copilot.
 *
 * The Guide explains; it never executes. These payloads are context only.
 */

import type {
  AssistantEventKind,
  AssistantImageAttachment,
  AssistantImageMime,
  AssistantSessionEvent,
} from "@/lib/copilot/types";

export const MAX_SESSION_EVENTS = 5;
export const MAX_ATTACHMENTS = 2;
/** ~260KB of base64. Keeps the JSON body well under typical 1MB API limits. */
export const MAX_IMAGE_B64_CHARS = 350_000;
export const MAX_EVENT_MESSAGE = 400;
export const ALLOWED_IMAGE_MIMES: readonly AssistantImageMime[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

const EVENT_KINDS = new Set<AssistantEventKind>([
  "wallet_rejected",
  "simulation_failed",
  "unsigned_xdr",
  "submitted_unconfirmed",
  "horizon_failed",
  "horizon_success",
  "toast_error",
  "toast_success",
]);

const TX_HASH = /\b([a-f0-9]{64})\b/i;

export function extractTxHash(text: string | null | undefined): string | null {
  if (!text) return null;
  const labeled = text.match(/tx:\s*([a-f0-9]{64})/i);
  if (labeled) return labeled[1].toLowerCase();
  const bare = text.match(TX_HASH);
  return bare ? bare[1].toLowerCase() : null;
}

/**
 * True when the user is asking what went wrong with an action — Guide work,
 * not a write. Live "what's my HF" stays on the MCP read path.
 */
export function isDiagnosisMessage(message: string): boolean {
  const m = message.trim();
  if (!m) return false;
  if (TX_HASH.test(m) && m.length <= 80) return true;
  if (TX_HASH.test(m) && /\b(tx|hash|transaction|what|why|happen|fail|status|land)\b/i.test(m)) {
    return true;
  }
  // Require a failure noun. Bare "why is my health factor" is a live read, not diagnosis.
  return /\b(fail(?:ed|ure)?|didn'?t\s+(?:go(?:\s+through)?|work|execute|land|submit|send)|went\s+wrong|what\s+happened|wallet\s+reject|rejected\s+it|user\s+reject|revert(?:ed)?|simulation|wouldn'?t\s+(?:go|work|send))\b/i.test(
    m,
  );
}

/**
 * Which failure stage a message describes.
 *
 * The distinction that matters is wallet-cancel versus on-chain failure: calling a
 * closed Freighter prompt a "failed transaction" is the single most misleading thing
 * this surface can say, and it is exactly what happens when the raw string is passed
 * through unclassified. Cancel patterns are therefore checked FIRST and deliberately
 * include the signer's own wording ("Signing was cancelled.", "Cancelled — transaction
 * was not submitted.") as well as the wallet's.
 */
export function classifyToastMessage(raw: string): AssistantEventKind {
  const t = raw.toLowerCase();
  if (
    /\b(cancel(?:l)?ed|declined|denied)\b/.test(t) &&
    /\b(user|wallet|sign(?:ing|ature)?|transaction was not submitted|by you)\b/.test(t)
  ) {
    return "wallet_rejected";
  }
  if (t.includes("user rejected") || t.includes("rejected by user")) return "wallet_rejected";
  if (t.includes("simulation")) return "simulation_failed";
  if (
    t.includes("unsigned") ||
    t.includes("sign in your wallet") ||
    t.includes("sign with connected wallet") ||
    t.includes("waiting for your signature")
  ) {
    return "unsigned_xdr";
  }
  if (
    extractTxHash(raw) &&
    /(pending|not found|unconfirmed|not confirmed|waiting for the ledger|may still land)/i.test(t)
  ) {
    return "submitted_unconfirmed";
  }
  if (
    /(transaction failed|failed on-chain|on-chain contract rejected|horizon rejected|submission rejected|error\(contract)/i.test(
      t,
    )
  ) {
    return "horizon_failed";
  }
  return "toast_error";
}

export function sanitizeSessionEvents(raw: unknown): AssistantSessionEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: AssistantSessionEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = String(o.kind || "") as AssistantEventKind;
    if (!EVENT_KINDS.has(kind)) continue;
    const message = String(o.message || "").trim().slice(0, MAX_EVENT_MESSAGE);
    if (!message) continue;
    const at = typeof o.at === "number" && Number.isFinite(o.at) ? o.at : Date.now();
    const tx_hash = extractTxHash(typeof o.tx_hash === "string" ? o.tx_hash : message);
    const code =
      typeof o.code === "string" && o.code.trim() ? o.code.trim().slice(0, 80) : null;
    const path =
      typeof o.path === "string" && o.path.startsWith("/") ? o.path.slice(0, 120) : null;
    out.push({ kind, message, at, tx_hash, code, path });
    if (out.length >= MAX_SESSION_EVENTS) break;
  }
  return out;
}

export function sanitizeAttachments(raw: unknown): AssistantImageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: AssistantImageAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const mime = String(o.mime || "") as AssistantImageMime;
    if (!ALLOWED_IMAGE_MIMES.includes(mime)) continue;
    const data = String(o.data || "").replace(/\s+/g, "");
    if (!data || data.length > MAX_IMAGE_B64_CHARS) continue;
    if (!/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 80))) continue;
    const source = o.source === "drop" || o.source === "region" || o.source === "paste" ? o.source : "paste";
    out.push({
      mime,
      data,
      source,
      width: typeof o.width === "number" ? o.width : undefined,
      height: typeof o.height === "number" ? o.height : undefined,
    });
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

export function formatSessionEventsForPrompt(events: AssistantSessionEvent[]): string {
  if (!events.length) return "SESSION EVENTS: (none)";
  return [
    "SESSION EVENTS (most recent last — facts from this browser session, not guesses):",
    ...events.map((e) => {
      const hash = e.tx_hash ? ` hash=${e.tx_hash}` : "";
      const code = e.code ? ` code=${e.code}` : "";
      const path = e.path ? ` path=${e.path}` : "";
      return `- ${e.kind}: ${e.message}${hash}${code}${path}`;
    }),
  ].join("\n");
}
