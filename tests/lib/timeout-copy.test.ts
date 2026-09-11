import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The user-facing investigation abort must never print this sentence. It replaced
 * a real partial result with a dead-end, and it is the copy they asked never to
 * see again.
 */
const FORBIDDEN = "The investigation timed out. Please try again.";

describe("investigation timeout copy", () => {
  it("is gone from the investigation and workflow hooks", () => {
    const hooks = [
      readFileSync("hooks/use-investigation.ts", "utf8"),
      readFileSync("hooks/use-workflow.ts", "utf8"),
      readFileSync("hooks/use-copilot-entry.ts", "utf8"),
    ].join("\n");
    expect(hooks).not.toContain(FORBIDDEN);
  });
});
