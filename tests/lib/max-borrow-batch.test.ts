import { describe, expect, it, vi } from "vitest";
import { createMaxBorrowBatcher } from "@/lib/copilot/max-borrow-batch";

const ACCOUNT = "CACCOUNT";
const row = (symbol: string) => ({ symbol, max_borrow_human: `${symbol}-max` });

function setup(overrides: { batch?: (args: { smart_account: string; symbols: string[] }) => Promise<Record<string, unknown>> } = {}) {
  const single = vi.fn(async (args: Record<string, unknown>) => row(String(args.symbol)));
  const batch = vi.fn(overrides.batch ?? (async (args: { smart_account: string; symbols: string[] }) => ({
    smart_account: args.smart_account,
    results: Object.fromEntries(args.symbols.map((s) => [s, row(s)])),
  })));
  const paths: string[] = [];
  let clock = 0;
  const batcher = createMaxBorrowBatcher({
    single, batch, identity: (id) => id ?? "", windowMs: 1, retryAfterMs: 1_000,
    now: () => clock, onPath: (p) => paths.push(p),
  });
  return { batcher, single, batch, paths, tick: (ms: number) => { clock += ms; } };
}

const ask = (b: ReturnType<typeof setup>["batcher"], symbol: string, account = ACCOUNT, user = "u1") =>
  b.read({ smart_account: account, symbol }, user);

describe("max-borrow batching", () => {
  it("joins reads made together into one call and gives each caller its own answer", async () => {
    const { batcher, single, batch } = setup();
    const out = await Promise.all(["BLUSDC", "XLM", "AQUSDC", "SOUSDC"].map((s) => ask(batcher, s)));
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0].symbols).toEqual(["BLUSDC", "XLM", "AQUSDC", "SOUSDC"]);
    expect(single).not.toHaveBeenCalled();
    expect(out.map((r) => r.symbol)).toEqual(["BLUSDC", "XLM", "AQUSDC", "SOUSDC"]);
  });

  it("a lone read stays a normal single call", async () => {
    const { batcher, single, batch } = setup();
    expect((await ask(batcher, "XLM")).symbol).toBe("XLM");
    expect(batch).not.toHaveBeenCalled();
    expect(single).toHaveBeenCalledTimes(1);
  });

  it("never joins different accounts or different users", async () => {
    const { batcher, batch, single } = setup();
    await Promise.all([ask(batcher, "XLM", "CA", "u1"), ask(batcher, "BLUSDC", "CB", "u1"), ask(batcher, "AQUSDC", "CA", "u2")]);
    expect(batch).not.toHaveBeenCalled();
    expect(single).toHaveBeenCalledTimes(3);
  });

  it("a symbol the batch could not answer is read on its own; the others keep their batch answer", async () => {
    const { batcher, single } = setup({
      batch: async (args) => ({
        results: { [args.symbols[0]]: row(args.symbols[0]), [args.symbols[1]]: { error: "max_borrow_failed" } },
      }),
    });
    const [a, b] = await Promise.all([ask(batcher, "BLUSDC"), ask(batcher, "XLM")]);
    expect(a.symbol).toBe("BLUSDC");
    expect(b.symbol).toBe("XLM");
    expect(single).toHaveBeenCalledTimes(1);
    expect(single.mock.calls[0][0]).toMatchObject({ symbol: "XLM" });
  });

  it("falls back to single reads when the server has no batch action, and does not retry it for a while", async () => {
    const { batcher, single, batch, paths, tick } = setup({ batch: async () => { throw new Error("Unknown action: max_borrow_all"); } });
    await Promise.all([ask(batcher, "BLUSDC"), ask(batcher, "XLM")]);
    expect(single).toHaveBeenCalledTimes(2);
    expect(batch).toHaveBeenCalledTimes(1);
    await Promise.all([ask(batcher, "BLUSDC"), ask(batcher, "XLM")]);
    expect(batch).toHaveBeenCalledTimes(1);
    tick(2_000);
    await Promise.all([ask(batcher, "BLUSDC"), ask(batcher, "XLM")]);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(paths).toEqual(["single", "single", "single"]);
  });

  it("an error payload from the batch is treated as unsupported, not as an answer", async () => {
    const { batcher, single } = setup({ batch: async () => ({ error: "invalid_symbols" }) });
    await Promise.all([ask(batcher, "BLUSDC"), ask(batcher, "XLM")]);
    expect(single).toHaveBeenCalledTimes(2);
  });
});
