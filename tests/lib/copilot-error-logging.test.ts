import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { logUnexpected, unexpectedCause } from "@/lib/copilot/log";

/**
 * A generic 409 with no console.error is how a funded repay looked impossible.
 * These routes must log the thrown value (name, message, stack) before that copy.
 */
const ROUTES = [
  "app/api/copilot/workflow/propose/route.ts",
  "app/api/copilot/workflow/[id]/approve/route.ts",
  "app/api/copilot/workflow/[id]/submit/route.ts",
  "app/api/copilot/workflow/[id]/confirm/route.ts",
  "app/api/copilot/workflow/[id]/advance/route.ts",
  "app/api/copilot/investigate/route.ts",
];

describe("unexpected copilot failures are logged", () => {
  it("each investigate/workflow route logs the caught error before generic copy", () => {
    for (const file of ROUTES) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toMatch(/logUnexpected\(/);
    }
  });

  it("serializes Error as name, message, and stack", () => {
    const error = new Error("price_unavailable");
    expect(unexpectedCause(error)).toEqual({
      name: "Error",
      message: "price_unavailable",
      stack: error.stack,
    });
  });

  it("console.errors the cause before the caller returns generic copy", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new TypeError("fetch failed");
    logUnexpected("proposal failed", { candidateId: "repay_xlm", error });
    expect(spy).toHaveBeenCalledWith("[copilot] proposal failed", {
      candidateId: "repay_xlm",
      error: { name: "TypeError", message: "fetch failed", stack: error.stack },
    });
    spy.mockRestore();
  });
});
