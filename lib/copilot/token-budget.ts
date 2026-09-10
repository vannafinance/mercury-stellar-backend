import { AsyncLocalStorage } from "node:async_hooks";
import { copilotConfig } from "./config";

/**
 * Per-subject daily Vertex token cap. The regex firewall was a billing backstop;
 * this is the actual meter. In-memory, one process — same deployment assumption as
 * write-dedupe. Guest traffic shares the "guest" bucket. The subject must be the
 * verified Privy/WorkOS `sub` (or `"guest"`), never the client-supplied `user_id`.
 */

const subjectStore = new AsyncLocalStorage<string>();

type DayBucket = { date: string; tokens: number };
const usage = new Map<string, DayBucket>();

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function withTokenSubject<T>(subject: string, fn: () => T): T {
  return subjectStore.run(subject, fn);
}

export function currentTokenSubject(): string | undefined {
  return subjectStore.getStore();
}

export function recordTokenUsage(subject: string, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const day = todayUtc();
  const bucket = usage.get(subject);
  if (!bucket || bucket.date !== day) usage.set(subject, { date: day, tokens: Math.ceil(tokens) });
  else bucket.tokens += Math.ceil(tokens);
}

export function tokenUsageToday(subject: string): number {
  const bucket = usage.get(subject);
  if (!bucket || bucket.date !== todayUtc()) return 0;
  return bucket.tokens;
}

export function wouldExceedTokenCap(subject: string): boolean {
  return tokenUsageToday(subject) >= copilotConfig.dailyTokenCap;
}

export function tokenCapMessage(): string {
  return "This account has reached today’s Copilot token budget. I still won’t execute anything. Try again tomorrow, or ask a shorter product question.";
}

/** Test-only. */
export function resetTokenUsage(): void {
  usage.clear();
}
