import { describe, it, expect } from "vitest";
import { zoneOf } from "@/components/copilot/health-dial";

describe("health zones match the protocol, not a guess", () => {
  it("puts the liquidation boundary at 1.10", () => {
    // lib/margin-health.ts: liquidation at 1.10, no threshold haircut. A gauge that drew
    // the line anywhere else would understate or overstate danger.
    expect(zoneOf(1.09)).toBe("danger");
    expect(zoneOf(1.1)).toBe("danger");
    expect(zoneOf(1.11)).toBe("warn");
  });

  it("bands above the line", () => {
    expect(zoneOf(1.29)).toBe("warn");
    expect(zoneOf(1.3)).toBe("caution");
    expect(zoneOf(1.79)).toBe("caution");
    expect(zoneOf(1.8)).toBe("healthy");
    expect(zoneOf(4.2)).toBe("healthy");
  });

  it("reports an unavailable reading as unknown, never as healthy", () => {
    // A gauge that defaults to green when the position read failed is worse than no gauge.
    expect(zoneOf(null)).toBe("unknown");
    expect(zoneOf(undefined)).toBe("unknown");
    expect(zoneOf(Number.NaN)).toBe("unknown");
  });
});
