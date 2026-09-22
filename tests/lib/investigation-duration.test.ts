import { describe, expect, it } from "vitest";
import { formatElapsedMs, formatRunClock } from "@/lib/copilot/investigation/duration";

describe("formatRunClock", () => {
  it("formats seconds and frozen minute clocks without padding a sub-minute run", () => {
    expect(formatRunClock(0)).toBe("0s");
    expect(formatRunClock(12)).toBe("12s");
    expect(formatRunClock(59.9)).toBe("59s");
    expect(formatRunClock(60)).toBe("1m 00s");
    expect(formatRunClock(125)).toBe("2m 05s");
    expect(formatElapsedMs(12_400)).toBe("12s");
    expect(formatElapsedMs(28 * 60_000 + 45_000)).toBe("28m 45s");
  });
});
