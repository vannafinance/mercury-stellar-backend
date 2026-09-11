import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("copilot session store", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("round-trips turns keyed by subject and ignores guests", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "copilot-session-"));
    dirs.push(cwd);
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const { saveSession, loadSession, appendSessionTurn } = await import("@/lib/copilot/session-store");
      await saveSession({
        subject: "guest", turns: [{ role: "user", text: "hi" }], continuation: null, result: null, updatedAt: 1,
      });
      expect(await loadSession("guest")).toBeNull();
      await appendSessionTurn({
        subject: "alice",
        user: "what's my health?",
        result: {
          status: "researched", message: "1.46", originalRequest: "what's my health?",
          refinements: [], understanding: null, question: null, facts: [], checks: [], warnings: [],
          continuation: "r1.token", executionAllowed: false,
          scope: { wallet: null, smartAccount: null, network: "testnet" },
        },
      });
      const loaded = await loadSession("alice");
      expect(loaded?.turns.map((turn) => turn.text)).toEqual(["what's my health?", "1.46"]);
      expect(loaded?.continuation).toBe("r1.token");
    } finally {
      process.chdir(previous);
    }
  });
});
