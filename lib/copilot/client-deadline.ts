/** Bound a client dependency that does not itself accept an AbortSignal. */
export async function withClientDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      stop = () => reject(new Error("The request timed out or was cancelled."));
      if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", stop); }
}
