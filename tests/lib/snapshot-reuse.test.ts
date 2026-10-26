import { beforeEach, describe, expect, it, vi } from "vitest";

const snap = vi.hoisted(() => ({ compute: vi.fn() }));
vi.mock("@/lib/account-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-snapshot")>()),
  computeMarginSnapshot: snap.compute,
}));

import { computeMarginSnapshotReused, resetSnapshotReuse, SNAPSHOT_REUSE_MS } from "@/lib/copilot/investigation/snapshot-reuse";

const ACCOUNT = "CACCOUNT";
const shot = (health: number) => ({ avgHealthFactor: health }) as never;

beforeEach(() => {
  process.env.COPILOT_SNAPSHOT_REUSE = "on";
  resetSnapshotReuse();
  snap.compute.mockReset();
});

describe("one account snapshot per turn", () => {
  it("hands the next caller a read that has just finished instead of starting another", async () => {
    snap.compute.mockResolvedValue(shot(2));
    const first = await computeMarginSnapshotReused(ACCOUNT, undefined, () => 1_000);
    const second = await computeMarginSnapshotReused(ACCOUNT, undefined, () => 1_000 + 3_000);
    expect(second).toBe(first);
    expect(snap.compute).toHaveBeenCalledTimes(1);
  });

  it("reads again once the window has passed", async () => {
    snap.compute.mockResolvedValueOnce(shot(2)).mockResolvedValueOnce(shot(3));
    await computeMarginSnapshotReused(ACCOUNT, undefined, () => 0);
    const later = await computeMarginSnapshotReused(ACCOUNT, undefined, () => SNAPSHOT_REUSE_MS + 1);
    expect(later).toEqual(shot(3));
    expect(snap.compute).toHaveBeenCalledTimes(2);
  });

  it("a caller that knows about a newer transaction is never served the older read, and its result is what the next one reuses", async () => {
    snap.compute.mockResolvedValueOnce(shot(2)).mockResolvedValueOnce(shot(5));
    await computeMarginSnapshotReused(ACCOUNT, undefined, () => 0);
    const afterTx = await computeMarginSnapshotReused(ACCOUNT, { freshAfter: "hash" }, () => 1_000);
    expect(afterTx).toEqual(shot(5));
    expect(snap.compute).toHaveBeenLastCalledWith(ACCOUNT, { freshAfter: "hash" });
    expect(await computeMarginSnapshotReused(ACCOUNT, undefined, () => 2_000)).toEqual(shot(5));
    expect(snap.compute).toHaveBeenCalledTimes(2);
  });

  it("never keeps a failed read", async () => {
    snap.compute.mockRejectedValueOnce(new Error("rpc down")).mockResolvedValueOnce(shot(2));
    await expect(computeMarginSnapshotReused(ACCOUNT, undefined, () => 0)).rejects.toThrow("rpc down");
    expect(await computeMarginSnapshotReused(ACCOUNT, undefined, () => 1)).toEqual(shot(2));
  });

  it("keeps accounts apart", async () => {
    snap.compute.mockResolvedValueOnce(shot(2)).mockResolvedValueOnce(shot(9));
    await computeMarginSnapshotReused("CA", undefined, () => 0);
    expect(await computeMarginSnapshotReused("CB", undefined, () => 1)).toEqual(shot(9));
  });

  it("is off with COPILOT_SNAPSHOT_REUSE=off", async () => {
    process.env.COPILOT_SNAPSHOT_REUSE = "off";
    snap.compute.mockResolvedValue(shot(2));
    await computeMarginSnapshotReused(ACCOUNT);
    await computeMarginSnapshotReused(ACCOUNT);
    expect(snap.compute).toHaveBeenCalledTimes(2);
  });
});
