/**
 * Development-only record of why a turn stopped, dropped a plan or lost a read.
 *
 * The same facts ride on `view.diagnostics`, but the browser throws a response away when the
 * next prompt closes its stream, and the dev terminal is not something an agent can read.
 * 23 Sep: #12 (XS5, two plans dropped) and #13 (X14, "no AQUSDC LP position was read") could
 * not be diagnosed for that reason. This appends one JSON line per turn under
 * `.local/copilot-diagnostics/`. Never in production, never under vitest, and never throws.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function appendDiagnostics(row: { message: string; status: string; diagnostics: unknown }): Promise<void> {
  if (process.env.NODE_ENV === "production" || process.env.VITEST || process.env.K_SERVICE) return;
  try {
    const directory = resolve(process.cwd(), ".local", "copilot-diagnostics");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const at = new Date();
    const line = JSON.stringify({ at: at.toISOString(), message: row.message.slice(0, 300), status: row.status, diagnostics: row.diagnostics });
    await appendFile(join(directory, `${at.toISOString().slice(0, 10)}.jsonl`), `${line}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // A diagnostics log must never affect a turn.
  }
}
