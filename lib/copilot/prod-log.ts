/**
 * A log line that survives a production build.
 *
 * next.config.ts strips every console.* but console.error from production bundles, so the
 * investigation's phase lines never reached Cloud Logging (24 Oct 2026: two live failures could
 * not be diagnosed, and which reads ran in a turn could not be seen at all). A line written
 * straight to stdout as JSON is not touched by that, and Cloud Run turns it into a structured
 * entry: `severity` becomes the entry's severity, the rest lands in `jsonPayload`.
 *
 * Outside production the console line is unchanged. Fields are for structural facts only (names,
 * counts, timings, reasons); never a prompt, a payload, a token or an address.
 */
export function copilotLog(message: string, fields: Record<string, unknown> = {}): void {
  try {
    if (process.env.NODE_ENV !== "production") {
      console.info(message, fields);
      return;
    }
    // Spread first so a caller's field can never replace the line's own severity or component.
    process.stdout.write(`${JSON.stringify({ ...fields, severity: "INFO", message, component: "copilot" })}\n`);
  } catch {
    // Logging must never fail a turn.
  }
}
