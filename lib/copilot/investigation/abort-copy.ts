/** User-facing copy for a stopped investigation. Deadline, abort, and a dead connection are not the same. */

export const RESEARCH_DEADLINE_MESSAGE =
  "The investigation ran out of time before it could finish. Nothing was executed — please try again.";

export const RESEARCH_ABORTED_MESSAGE =
  "This investigation was replaced or cancelled. Nothing was executed — send the prompt again if you still want it.";

export const RESEARCH_UNREACHABLE_MESSAGE =
  "The copilot didn't respond. Nothing was executed — send the prompt again.";

export function investigationStopCopy(reason: unknown): {
  code: "research_deadline" | "research_aborted" | "research_unreachable";
  message: string;
} {
  if (reason === "unreachable") {
    return { code: "research_unreachable", message: RESEARCH_UNREACHABLE_MESSAGE };
  }
  if (reason === "deadline" || reason === "TimeoutError") {
    return { code: "research_deadline", message: RESEARCH_DEADLINE_MESSAGE };
  }
  return { code: "research_aborted", message: RESEARCH_ABORTED_MESSAGE };
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "AbortError" || name === "TimeoutError" || name === "ResponseAborted";
}
