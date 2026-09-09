/** Explicit text Flash deployments only. No provider or Pro fallback in research. */
export function assertFlashModel(model: string): void {
  if (!/^gemini-\d+(?:\.\d+)?-flash(?:-preview(?:-\d{2}-\d{2})?|-\d{3})?$/.test(model)) {
    throw new Error("Investigation requires a configured Gemini Flash text model");
  }
}
