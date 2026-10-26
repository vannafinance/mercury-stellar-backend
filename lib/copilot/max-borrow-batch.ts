/**
 * Several `vanna_get_max_borrow` reads in the same instant become ONE `vanna_get_max_borrow_all` call.
 *
 * The research loop asks for each borrowable asset separately (26 Oct, live: four reads in one turn, 4.6 s,
 * 5.3 s, 5.4 s and 19.6 s). Each one re-read the account snapshot and the price on the server, and all four
 * searched the chain at once against the same RPC. One call shares that work.
 *
 * Callers do not change: each still awaits its own `vanna_get_max_borrow` answer, in the same shape, so the
 * evidence, the plan sizing and the model prompt are untouched.
 *
 * Fallback (labelled, temporary): a server that does not have the batch action yet answers with an error;
 * every waiting read then runs on its own, exactly as before, and the batch is not tried again for a while.
 * Remove the fallback once the batch action is live everywhere. `onPath` reports `batch` or `single`.
 */

type Row = Record<string, unknown>;

export interface MaxBorrowBatchDeps {
  single(args: Row, userId?: string): Promise<Row>;
  batch(args: { smart_account: string; symbols: string[] }, userId?: string): Promise<Row>;
  /** Who the read is for; reads for different identities or accounts are never joined. */
  identity(userId?: string): string;
  windowMs?: number;
  /** How long a failed batch is not retried. */
  retryAfterMs?: number;
  now?: () => number;
  onPath?: (path: "batch" | "single", detail: { symbols: number }) => void;
}

interface Waiter {
  args: Row;
  symbol: string;
  resolve: (value: Row) => void;
  reject: (error: unknown) => void;
}

interface Group {
  smartAccount: string;
  userId?: string;
  waiters: Waiter[];
}

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);

export function createMaxBorrowBatcher(deps: MaxBorrowBatchDeps) {
  const windowMs = deps.windowMs ?? 25;
  const retryAfterMs = deps.retryAfterMs ?? 10 * 60_000;
  const now = deps.now ?? Date.now;
  const groups = new Map<string, Group>();
  let batchOffUntil = 0;

  async function runSingles(waiters: Waiter[], userId?: string): Promise<void> {
    await Promise.all(waiters.map((w) => deps.single(w.args, userId).then(w.resolve, w.reject)));
  }

  async function flush(group: Group): Promise<void> {
    const { waiters, userId } = group;
    const symbols = [...new Set(waiters.map((w) => w.symbol))];
    if (symbols.length < 2 || now() < batchOffUntil) {
      deps.onPath?.("single", { symbols: symbols.length });
      return runSingles(waiters, userId);
    }
    let results: Row | null = null;
    try {
      const response = await deps.batch({ smart_account: group.smartAccount, symbols }, userId);
      if (isRow(response) && isRow(response.results) && !response.error) results = response.results;
    } catch {
      results = null;
    }
    if (!results) {
      // Older server, or the call itself failed: ask the way it was always asked.
      batchOffUntil = now() + retryAfterMs;
      deps.onPath?.("single", { symbols: symbols.length });
      return runSingles(waiters, userId);
    }
    deps.onPath?.("batch", { symbols: symbols.length });
    const rest: Waiter[] = [];
    for (const waiter of waiters) {
      const row = results[waiter.symbol];
      // A symbol the batch could not answer is read on its own; one bad asset does not hide the others.
      if (isRow(row) && !row.error) waiter.resolve(row);
      else rest.push(waiter);
    }
    if (rest.length) await runSingles(rest, userId);
  }

  /** The first caller of a group flushes it, in its own async context (identity travels with it). */
  async function read(args: Row, userId?: string): Promise<Row> {
    const smartAccount = typeof args.smart_account === "string" ? args.smart_account : "";
    const symbol = typeof args.symbol === "string" ? args.symbol : "";
    if (!smartAccount || !symbol) return deps.single(args, userId);
    const key = `${deps.identity(userId)}|${smartAccount}`;
    let group = groups.get(key);
    const leader = !group;
    if (!group) {
      group = { smartAccount, userId, waiters: [] };
      groups.set(key, group);
    }
    const answer = new Promise<Row>((resolve, reject) => group!.waiters.push({ args, symbol, resolve, reject }));
    if (leader) {
      await new Promise<void>((done) => setTimeout(done, windowMs));
      groups.delete(key);
      await flush(group);
    }
    return answer;
  }

  return { read };
}
