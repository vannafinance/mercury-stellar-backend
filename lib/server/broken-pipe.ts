/**
 * Keep the Node process answering HTTP after a broken stdout/stderr pipe or a
 * write to a socket the peer already closed.
 *
 * Next.js 16.2.3 does not yet ship https://github.com/vercel/next.js/pull/96242
 * (`setupBrokenPipeHandling`, still open on 10 Sep 2026). Without it, an
 * `EPIPE` on `process.stdout` becomes `uncaughtException`, Next logs that over
 * the same dead pipe, and the event loop spins while the server still accepts
 * TCP and never replies — the live failure in HANDOFF-phase-P2-planner-cut.md.
 *
 * Node documents EPIPE as "write on a pipe/socket with no reader"
 * (https://nodejs.org/api/errors.html). Handling the stream `error` event
 * prevents that from becoming uncaught. Swallowing *other* uncaught exceptions
 * is not this module's job.
 */

const FATAL_CODES = new Set(["EPIPE", "ECONNRESET", "EBADF", "ERR_STREAM_DESTROYED"]);

const handledStreams = new WeakSet<object>();

export function isPipeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error && error.code != null ? String(error.code) : "";
  if (FATAL_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /EPIPE|broken pipe/i.test(message);
}

function noopWrite(this: NodeJS.WriteStream, _chunk?: unknown, encodingOrCb?: unknown, cb?: unknown): boolean {
  const done = typeof encodingOrCb === "function" ? encodingOrCb : typeof cb === "function" ? cb : null;
  if (done) queueMicrotask(() => done());
  return true;
}

/** Replace writes with a no-op so nothing retries a dead destination. */
export function blackholeStream(stream: NodeJS.WriteStream): void {
  stream.write = noopWrite as typeof stream.write;
}

export function silenceBrokenPipe(stream: NodeJS.WriteStream): void {
  if (handledStreams.has(stream)) return;
  handledStreams.add(stream);
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (!isPipeError(error)) return;
    blackholeStream(stream);
  });
}

export function setupBrokenPipeHandling(): void {
  if (typeof process === "undefined" || !process.stdout || !process.stderr) return;
  silenceBrokenPipe(process.stdout);
  silenceBrokenPipe(process.stderr);
  const flag = process as NodeJS.Process & { __vannaBrokenPipeGuard?: boolean };
  if (flag.__vannaBrokenPipeGuard) return;
  flag.__vannaBrokenPipeGuard = true;
  // Run before Next's router-server logger. No-op the streams first so that
  // logger cannot write another EPIPE into a loop.
  process.prependListener("uncaughtException", (error) => {
    if (!isPipeError(error)) return;
    blackholeStream(process.stdout);
    blackholeStream(process.stderr);
  });
}
