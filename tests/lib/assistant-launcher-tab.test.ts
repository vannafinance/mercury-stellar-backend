import { describe, expect, it } from "vitest";
import { clampLauncherY } from "@/components/copilot/assistant-launcher";

describe("the closed Assist tab only moves up and down", () => {
  it("keeps the tab below the navbar and inside the bottom of the window", () => {
    const vh = 800;
    expect(clampLauncherY(-200, vh)).toBe(64);
    expect(clampLauncherY(300, vh)).toBe(300);
    const lowest = clampLauncherY(5000, vh);
    expect(lowest).toBeLessThan(vh);
    expect(lowest).toBeGreaterThan(300);
  });

  it("holds a short window at the top limit instead of going negative", () => {
    expect(clampLauncherY(400, 120)).toBe(64);
  });
});
