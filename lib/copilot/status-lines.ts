/**
 * The short progress lines the chat shows while a reply is being worked out ("Reading your margin account…"),
 * worded by the model for the user's own prompt (as on the Solana Copilot) instead of a stage label and a clock.
 *
 * Cosmetic only. The lines describe what the Copilot is about to look at; they never state a result, an amount or a
 * figure, and nothing here touches research, a plan or a transaction. Any failure returns no lines and the chat falls
 * back to its own progress label. The call is small, counted against the user's daily token budget, and has its own
 * per-minute window so it cannot be used to run the model outside the chat's limits.
 */

import { copilotConfig } from "./config";
import { wouldExceedTokenCap, withTokenSubject } from "./token-budget";
import { generateInvestigationJson } from "./vertex";

const MAX_MESSAGE_CHARS = 600;
const MAX_LINES = 4;
const MAX_LINE_CHARS = 48;
const STATUS_TIMEOUT_MS = 6_000;
/** Status requests per user per minute: one per sent message is the normal rate. */
const PER_MINUTE = 12;

const STATUS_SCHEMA = {
  type: "OBJECT",
  properties: {
    lines: {
      type: "ARRAY",
      description: "Three or four progress lines, in the order the work happens.",
      items: { type: "STRING" },
    },
  },
  required: ["lines"],
} as const;

const STATUS_SYSTEM = `You write the short progress lines an assistant shows while it works on a request in Vanna, a Stellar app for lending (Earn pools), margin accounts (deposit, borrow, repay, withdraw, leverage), swaps and farms (Blend, Aquarius, Soroswap).
Given the user's message, return 3 or 4 lines that say what the assistant is doing for THAT request, in order.
Each line: a present-participle phrase of at most 6 words, ending with "…". Examples: "Reading your margin account…", "Checking the XLM price…", "Sizing the borrow against your health floor…".
Rules:
- Describe actions only, never results or conclusions.
- No numbers, amounts, prices, percentages or dates. Asset names (XLM, USDC) are fine.
- Never say anything was done, sent, signed, approved or executed.
- No advice and no questions.
- Write in the language of the user's message.
- If the message is unclear or off-topic, write lines about reading and understanding the request.`;

/** Lines that break the rules (figures, claims, long) are dropped rather than shown. */
export function cleanStatusLines(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    let line = item.replace(/\s+/g, " ").trim();
    if (!line || /\d/.test(line)) continue;
    if (/\b(done|sent|signed|approved|executed|completed|confirmed)\b/i.test(line)) continue;
    if (line.length > MAX_LINE_CHARS) continue;
    if (!/(…|\.\.\.)$/.test(line)) line = `${line.replace(/[.!]+$/, "")}…`;
    out.push(line.replace(/\.\.\.$/, "…"));
    if (out.length === MAX_LINES) break;
  }
  return out;
}

const recent = new Map<string, number[]>();

/** A sliding one-minute window per user, in this process. */
function allowed(subject: string, now = Date.now()): boolean {
  const kept = (recent.get(subject) ?? []).filter((at) => now - at < 60_000);
  if (kept.length >= PER_MINUTE) {
    recent.set(subject, kept);
    return false;
  }
  kept.push(now);
  recent.set(subject, kept);
  if (recent.size > 5_000) recent.delete(recent.keys().next().value as string);
  return true;
}

export async function statusLinesFor(subject: string, message: string): Promise<string[]> {
  const text = message.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!text || wouldExceedTokenCap(subject) || !allowed(subject)) return [];
  try {
    const parsed = await withTokenSubject(subject, () =>
      generateInvestigationJson(copilotConfig.vertexModel, STATUS_SYSTEM, text, AbortSignal.timeout(STATUS_TIMEOUT_MS), "LOW", [], STATUS_SCHEMA as unknown as Record<string, unknown>),
    );
    return cleanStatusLines((parsed as { lines?: unknown } | null)?.lines);
  } catch {
    return [];
  }
}
