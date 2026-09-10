import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("legacy keyword executor is gone", () => {
  it("is not exported from the investigation view", () => {
    const src = readFileSync("lib/copilot/investigation/view.ts", "utf8");
    expect(src).not.toMatch(/shouldUseLegacyExecutor/);
  });

  it("is not imported or called by the copilot workspace", () => {
    const src = readFileSync("components/copilot/copilot-workspace.tsx", "utf8");
    expect(src).not.toMatch(/shouldUseLegacyExecutor/);
  });
});
