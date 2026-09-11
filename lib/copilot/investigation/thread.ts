/**
 * Session rows that used to move as one switch. They move independently:
 *
 *   Transcript  — what's on screen. Never reset on a new goal.
 *   Evidence    — facts read from chain. Carry across runs, with staleness.
 *   Commitment  — the open question, the proposal, the approval fingerprint.
 *
 * "Start fresh" means only the third row. Independent-vs-continuation is a
 * heuristic and will misfire; keeping transcript and evidence makes a wrong
 * "independent" call cheap. Resetting them silently destroys the user's context.
 */

import type { ResearchView } from "./view";

export type ThreadTurn = {
  role: "user" | "assistant";
  text: string;
  question?: string | null;
};

export type LastInvestigation = {
  question: string | null;
  status?: string;
  understanding?: { intent?: string } | null;
};

export function isRefinement(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (isIndependentGoal(text) && !/instead|make it|change (the )?(floor|budget)|also use|use \S+ too/i.test(text)) {
    return false;
  }
  return /instead|make it|change (the )?(floor|budget|hf|health)|use \S+ too|also use|don'?t borrow|no (new )?borrow|you can borrow|may borrow|switch|higher floor|lower floor|\b1\.\d\b/i.test(text);
}

/** Health / price / "am I safe" — a new objective that must not inherit the last plan. */
export function isFactualIndependent(message: string): boolean {
  return /^(what'?s|whats|wats|how much is|price of|am i|is my)\b/i.test(message.trim());
}

/** Health / repay / price questions that must not inherit a prior strategy objective. */
export function isIndependentGoal(message: string): boolean {
  return isFactualIndependent(message)
    || /^(repay|lend|deposit|withdraw|borrow)\s+\d/i.test(message.trim());
}

/**
 * Inherit the sealed objective (messages + lastQuestion). Only an answer to an
 * open question, or a refinement of the current plan. Independent goals start a
 * new objective; they still carry transcript and evidence on other channels.
 */
export function shouldContinueInvestigation(
  message: string,
  last: LastInvestigation | null,
): boolean {
  if (!last) return false;
  if (isIndependentGoal(message)) return false;
  if (last.question) return true;
  if (last.understanding?.intent === "strategy" || last.status === "researched") {
    return isRefinement(message);
  }
  return false;
}

/**
 * Kill the awaiting proposal / approval fingerprint. Factual side-questions keep
 * a plan that is already on screen; a new write, a new strategy, or a floor
 * refinement replaces it because the fingerprint is bound to one specific plan.
 */
export function shouldReplacePlan(message: string, last: LastInvestigation | null): boolean {
  if (shouldContinueInvestigation(message, last)) {
    return Boolean(last && !last.question && isRefinement(message));
  }
  if (isFactualIndependent(message)) return false;
  return true;
}

const STORAGE_PREFIX = "vanna.copilot.thread.";

export type StoredThread = {
  turns: ThreadTurn[];
  continuation: string | null;
  wallet: string;
  result: ResearchView | null;
};

export function threadStorageKey(wallet: string): string {
  return `${STORAGE_PREFIX}${wallet}`;
}

export function readStoredThread(wallet: string | null): StoredThread | null {
  if (!wallet || typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(threadStorageKey(wallet));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredThread;
    if (!parsed || parsed.wallet !== wallet || !Array.isArray(parsed.turns)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredThread(wallet: string | null, value: StoredThread): void {
  if (!wallet || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(threadStorageKey(wallet), JSON.stringify({
      turns: value.turns.slice(-16),
      continuation: value.continuation,
      wallet,
      result: value.result,
    }));
  } catch { /* quota — the live thread still works until reload */ }
}

export function clearStoredThread(wallet: string | null): void {
  if (!wallet || typeof sessionStorage === "undefined") return;
  try { sessionStorage.removeItem(threadStorageKey(wallet)); } catch { /* ignore */ }
}
