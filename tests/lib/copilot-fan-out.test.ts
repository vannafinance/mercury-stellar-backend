import { describe, expect, it } from "vitest";
import { fanOutReads } from "@/lib/copilot/fan-out";

describe("fanOutReads", () => {
  it("executes concurrently rather than summing sequential latencies (concurrency, not sum)", async () => {
    // Arbitrary items (not token names)
    const items = ["alpha", "beta", "gamma", "delta"];
    const delayMs = 60;
    const start = Date.now();

    const results = await fanOutReads(
      items,
      async (item) => {
        await new Promise((r) => setTimeout(r, delayMs));
        return { item, processed: true };
      },
      (item, reason) => ({ item, processed: false, error: String(reason) }),
      2000,
    );

    const elapsed = Date.now() - start;

    expect(results).toHaveLength(items.length);
    expect(results.every((r) => r.processed)).toBe(true);
    // 4 items * 60ms = 240ms if sequential.
    // Concurrently, wall-clock should be much closer to 60ms than 240ms.
    expect(elapsed).toBeLessThan(180);
  });

  it("does not let one stuck row hold the whole answer hostage (shared deadline fallback)", async () => {
    const items = [
      { id: "fast-1", duration: 10 },
      { id: "stuck", duration: 999999 }, // Never resolves within budget
      { id: "fast-2", duration: 15 },
    ];

    const results = await fanOutReads<
      (typeof items)[number],
      { id: string; status: "ok" | "failed"; error?: string }
    >(
      items,
      async (item) => {
        await new Promise((r) => setTimeout(r, item.duration));
        return { id: item.id, status: "ok" as const };
      },
      (item, reason) => ({
        id: item.id,
        status: "failed" as const,
        error: reason instanceof Error ? reason.message : String(reason),
      }),
      80, // Tiny budget
    );

    expect(results).toEqual([
      { id: "fast-1", status: "ok" },
      {
        id: "stuck",
        status: "failed",
        error: expect.stringContaining("deadline exceeded"),
      },
      { id: "fast-2", status: "ok" },
    ]);
  });

  it("preserves input order even when reads resolve out of order", async () => {
    const items = [
      { key: "slow", delay: 80 },
      { key: "medium", delay: 40 },
      { key: "fast", delay: 10 },
    ];

    const results = await fanOutReads(
      items,
      async (item) => {
        await new Promise((r) => setTimeout(r, item.delay));
        return item.key;
      },
      (item) => `err:${item.key}`,
      500,
    );

    // Input order was slow, medium, fast
    expect(results).toEqual(["slow", "medium", "fast"]);
  });

  it("produces no unhandled rejection when a read rejects after the deadline has passed", async () => {
    let unhandledOccurred = false;
    const onUnhandled = () => {
      unhandledOccurred = true;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const items = ["will-reject-late"];

      const results = await fanOutReads(
        items,
        async () => {
          // Read sleeps past budget then rejects
          await new Promise((r) => setTimeout(r, 60));
          throw new Error("Late RPC failure on testnet");
        },
        (item, err) => ({ item, failed: true, reason: String(err) }),
        20, // Deadline fires at 20ms, well before the 60ms rejection
      );

      expect(results).toHaveLength(1);
      expect(results[0].failed).toBe(true);

      // Wait past the 60ms late rejection
      await new Promise((r) => setTimeout(r, 80));

      expect(unhandledOccurred).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("generalises to arbitrary types and handles empty input cleanly", async () => {
    const empty = await fanOutReads(
      [],
      async (x: number) => x * 2,
      (x) => x,
    );
    expect(empty).toEqual([]);

    const numbers = [10, 20, 30];
    const squared = await fanOutReads(
      numbers,
      async (n) => n * n,
      (n) => -n,
    );
    expect(squared).toEqual([100, 400, 900]);
  });
});
