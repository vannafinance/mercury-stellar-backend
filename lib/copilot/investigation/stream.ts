import type { ResearchStreamEvent } from "./view";

/** Browser-safe NDJSON reader. A research response has no execution dispatch path. */
export async function consumeResearchStream(response: Response, onEvent: (event: ResearchStreamEvent) => void): Promise<void> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.message === "string" ? body.message : "Investigation is unavailable. Please try again.");
  }
  if (!response.body) throw new Error("The investigation returned no response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  let events = 0;
  const deliver = (line: string) => {
    if (!line.trim()) return;
    if (terminal || ++events > 64) throw new Error("Invalid investigation response.");
    const event = JSON.parse(line) as ResearchStreamEvent;
    if (event.type === "result") {
      if (event.result?.executionAllowed !== false || !Array.isArray(event.result.facts) || !Array.isArray(event.result.checks) ||
        typeof event.result.continuation !== "string") throw new Error("Invalid research result.");
      terminal = true;
    } else if (event.type === "error") {
      terminal = true;
    } else if (event.type !== "progress" || !event.event) throw new Error("Invalid investigation event.");
    onEvent(event);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 131_072) throw new Error("The investigation response was too large.");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        deliver(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) break;
    }
    if (buffer.trim()) deliver(buffer);
    if (!terminal) throw new Error("The connection closed before the investigation finished. Please try again.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
