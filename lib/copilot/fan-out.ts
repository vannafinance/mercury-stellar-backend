import { MCP_CALL_TIMEOUT_MS } from "./mcp-client";

/**
 * Read N independent rows without waiting for the sum of N.
 *
 * A fan-out whose rows do not depend on each other has no reason to be a sequential
 * sum of unbounded calls. Two properties it must have and did not:
 *
 *   1. Concurrency. The wall clock is the slowest row, not the total.
 *   2. A shared deadline. One stuck RPC cannot hold the whole answer hostage —
 *      it becomes a failed row, which every caller here already renders.
 *
 * The budget is NOT a number chosen here. It is the client's own single-call timeout:
 * independent calls running together should finish inside the window one call is
 * already allowed, and anything still outstanding has, by the client's own definition,
 * timed out. No call site invents a waiting time of its own.
 */
export async function fanOutReads<TIn, TOut>(
  items: readonly TIn[],
  read: (item: TIn) => Promise<TOut>,
  onFailure: (item: TIn, reason: unknown) => TOut,
  budgetMs: number = MCP_CALL_TIMEOUT_MS,
): Promise<TOut[]> {
  if (items.length === 0) {
    return [];
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlinePromise = new Promise<{ isDeadline: true }>((resolve) => {
    timer = setTimeout(() => resolve({ isDeadline: true }), budgetMs);
  });

  try {
    const itemPromises = items.map(async (item) => {
      // Convert each read to a never-rejecting promise BEFORE racing against the deadline.
      // If a read rejects after the deadline promise wins the race, an unhandled rejection
      // would crash Node unless a catch handler is attached beforehand.
      const safeReadPromise = Promise.resolve()
        .then(() => read(item))
        .then(
          (value) => ({ isDeadline: false as const, ok: true as const, value }),
          (err) => ({ isDeadline: false as const, ok: false as const, err }),
        );

      const result = await Promise.race([safeReadPromise, deadlinePromise]);

      if (result.isDeadline) {
        return onFailure(
          item,
          new Error(`fanOutReads deadline exceeded after ${budgetMs}ms`),
        );
      }

      if (result.ok) {
        return result.value;
      } else {
        return onFailure(item, result.err);
      }
    });

    return await Promise.all(itemPromises);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
