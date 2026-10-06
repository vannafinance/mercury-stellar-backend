/**
 * The one place the copilot's model ids, and what is known about their retirement, live.
 *
 * Switching to a newer model, or off one that is retiring, is a change to `MODEL_DEFAULTS` here
 * (or to the VERTEX_MODEL / VERTEX_MODEL_FALLBACKS / VERTEX_SOCIAL_MODEL env vars on a deploy). No
 * other file names a model, and nothing branches on a specific model: how a model is called is
 * decided by its family in vertex.ts, and the API itself refuses a field a model cannot take.
 *
 * Roles, not versions:
 *   research  the investigation loop, reply composition, domain classification
 *   fallback  tried in order when the research model 404s or is unavailable
 *   social    greetings only; needs a model that accepts MINIMAL thinking (3.7/3.8 do not)
 *
 * Google announced these retirements by email on 5 Oct 2026. After the date a request to the
 * model fails with HTTP 404, which is why a retired id is dropped from the candidates instead of
 * being tried and failing. Only dates Google has published belong in MODEL_RETIREMENTS; a model
 * without an entry is not claimed to be permanent, only not known to be retiring.
 */
export const MODEL_DEFAULTS = {
  research: "gemini-3.8-flash",
  fallback: ["gemini-3.5-flash"],
  social: "gemini-3.5-flash-lite",
  /**
   * Reasoning effort for the research loop's concluding turn (the goal and evidence-linked findings).
   * It belongs with the research model: how much a model thinks on that turn differs a lot between
   * models, so changing `research` is the moment to re-measure and, if needed, change this too.
   */
  // Measured 6 Oct 2026 on the synthetic investigation eval (6 runs, both prompts pass): gemini-3.8-flash with
  // this at MEDIUM passed 1/6 (the concluding turn spent ~3.9k thinking tokens, ~30 s, and ran the 45 s research
  // budget out); at LOW it passed 6/6. gemini-3.7-flash at MEDIUM passed 4/6 and gemini-3.5-flash 3/6.
  researchConcludeThinking: "LOW",
} as const;

export type ThinkingLevel = "LOW" | "MEDIUM";

export const MODEL_RETIREMENTS: Readonly<Record<string, string>> = {
  "gemini-3.6-flash": "2026-11-19",
  "gemini-3.7-flash": "2027-01-28",
};

/** How far ahead a retiring model is called out in the logs and by the guard test. */
export const RETIREMENT_WARNING_DAYS = 60;

export type RetirementStatus =
  | { state: "ok"; retiresOn: null; daysLeft: null }
  | { state: "retiring"; retiresOn: string; daysLeft: number }
  | { state: "retired"; retiresOn: string; daysLeft: number };

const DAY_MS = 86_400_000;

/** Whether a model is retired, retiring within the warning window, or not known to be retiring. */
export function retirementStatus(model: string, now: number = Date.now()): RetirementStatus {
  const retiresOn = MODEL_RETIREMENTS[model];
  if (!retiresOn) return { state: "ok", retiresOn: null, daysLeft: null };
  const daysLeft = Math.ceil((Date.parse(`${retiresOn}T00:00:00Z`) - now) / DAY_MS);
  if (daysLeft <= 0) return { state: "retired", retiresOn, daysLeft };
  return daysLeft <= RETIREMENT_WARNING_DAYS ? { state: "retiring", retiresOn, daysLeft } : { state: "ok", retiresOn: null, daysLeft: null };
}

/**
 * Candidates in the order to try them: retired ids are dropped, since a retired id only costs a
 * guaranteed 404. If every id is retired the list is kept as given, so the failure names the real
 * cause instead of an empty list.
 */
export function usableModels(models: readonly string[], now: number = Date.now()): string[] {
  const live = models.filter((model) => retirementStatus(model, now).state !== "retired");
  return live.length ? live : [...models];
}
