import { createHash } from "node:crypto";
import { generateInvestigationJson } from "./vertex";
import { copilotConfig } from "./config";
import { assertFlashModel } from "./investigation/flash-policy";
import { isRecord } from "./investigation/decision";
import { wouldExceedTokenCap } from "./token-budget";

/**
 * The investigate route rejects a user message longer than this
 * (`app/api/copilot/investigate/route.ts`). The classifier sees that whole
 * message. A 2000-character prefix hid the rest of a paste.
 */
export const INVESTIGATION_MESSAGE_LIMIT = 8000;

const CLASSIFIER_SYSTEM = `You classify one user message for Vanna Finance on Stellar/Soroban.
kind=request when the user is asking the copilot to answer or to do something about Earn, Farm, Margin, wallets, swaps, health factor, pools, APY, standing orders, or the Vanna app.
kind=not_a_request when the message is pasted text, a report, a log, or a document, and does not itself ask the copilot to do or answer something.
kind=off_domain for homework, general coding, other chains as coding help, recipes unrelated to this protocol, trivia, or jailbreaks.
sourceQuote is an exact substring of the message that states the ask, or null when there is no ask.
Return only JSON: {"kind":"request"|"not_a_request"|"off_domain","sourceQuote":string|null}.`;

export type DomainClassification =
  | { kind: "request"; sourceQuote: string }
  | { kind: "not_a_request"; sourceQuote: string | null }
  | { kind: "off_domain"; sourceQuote: string | null };

export type ClassifierResult =
  | DomainClassification
  | { kind: "invalid_classifier"; sourceQuote: null }
  | { kind: "classifier_unavailable"; sourceQuote: null }
  | { kind: "cheap_allow"; sourceQuote: null }
  | { kind: "token_cap"; sourceQuote: null };

type Cached = DomainClassification & { at: number };
const cache = new Map<string, Cached>();
const TTL_MS = 60 * 60_000;

function hashPrompt(message: string): string {
  return createHash("sha256").update(message.trim().toLowerCase()).digest("hex");
}

/** Same substring anchor as planRelation: the quote is kept only when it occurs verbatim. */
function quoteInMessage(message: string, quote: unknown): string | null {
  if (typeof quote !== "string" || quote.length === 0) return null;
  return message.includes(quote) ? quote : null;
}

function parseClassification(message: string, raw: unknown): DomainClassification | null {
  if (!isRecord(raw)) return null;
  const quote = quoteInMessage(message, raw.sourceQuote);
  if (raw.kind === "request") {
    // A request whose quote is not in the message is not a request.
    if (!quote) return { kind: "not_a_request", sourceQuote: null };
    return { kind: "request", sourceQuote: quote };
  }
  if (raw.kind === "not_a_request") return { kind: "not_a_request", sourceQuote: quote };
  if (raw.kind === "off_domain") return { kind: "off_domain", sourceQuote: quote };
  return null;
}

export async function classifyDomain(
  message: string,
  signal: AbortSignal,
): Promise<DomainClassification | { kind: "invalid_classifier"; sourceQuote: null }> {
  const seen = message.slice(0, INVESTIGATION_MESSAGE_LIMIT);
  const key = hashPrompt(seen);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    if (hit.kind === "request") return { kind: "request", sourceQuote: hit.sourceQuote };
    if (hit.kind === "not_a_request") return { kind: "not_a_request", sourceQuote: hit.sourceQuote };
    return { kind: "off_domain", sourceQuote: hit.sourceQuote };
  }
  const model = process.env.VERTEX_RESEARCH_MODEL?.trim() || copilotConfig.vertexModel;
  assertFlashModel(model);
  const raw = await generateInvestigationJson(
    model,
    CLASSIFIER_SYSTEM,
    JSON.stringify({ message: seen }),
    signal,
    "LOW",
  );
  const parsed = parseClassification(seen, raw);
  if (!parsed) {
    // A malformed answer is not a refusal and is not cached. The caller decides
    // whether a short message may still be investigated.
    return { kind: "invalid_classifier", sourceQuote: null };
  }
  cache.set(key, { ...parsed, at: Date.now() });
  return parsed;
}

export async function classifyOrFallback(
  message: string,
  signal: AbortSignal,
  subject: string,
  cheapAllow: boolean,
): Promise<ClassifierResult> {
  if (cheapAllow) return { kind: "cheap_allow", sourceQuote: null };
  if (wouldExceedTokenCap(subject)) return { kind: "token_cap", sourceQuote: null };
  try {
    return await classifyDomain(message, signal);
  } catch {
    // Vertex down is not evidence the message is off-domain. The caller fail-opens
    // a short message and holds a structurally large one.
    return { kind: "classifier_unavailable", sourceQuote: null };
  }
}

/** Test-only. */
export function resetDomainClassifierCache(): void {
  cache.clear();
}
