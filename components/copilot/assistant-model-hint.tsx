"use client";

/**
 * Client-safe label for which model powers the page assistant.
 * Server uses VERTEX_MODEL (default gemini-3.6-flash on Vertex AI).
 */
export function copilotConfigHint(): string {
  // Public env can override display; default matches lib/copilot/config.ts
  const model =
    (typeof process !== "undefined" && process.env.NEXT_PUBLIC_VERTEX_MODEL) ||
    "gemini-3.6-flash";
  return `Powered by ${model} via Google Vertex AI`;
}
