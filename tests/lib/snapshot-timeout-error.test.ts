import { describe, expect, it } from "vitest";
import { SnapshotTimeoutError } from "@/lib/account-snapshot";

describe("SnapshotTimeoutError", () => {
  it("is a named timeout, not a generic Error", () => {
    const error = new SnapshotTimeoutError("computeMarginSnapshot(C)", 12_000);
    expect(error.name).toBe("SnapshotTimeoutError");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/timed out after 12000ms/);
  });
});
