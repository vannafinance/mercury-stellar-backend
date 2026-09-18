import { describe, expect, it } from "vitest";
import { assistantPageLabel } from "@/lib/assistant/page-label";

describe("assistantPageLabel", () => {
  it("names common product routes instead of truncating the path", () => {
    expect(assistantPageLabel("/margin")).toBe("Margin");
    expect(assistantPageLabel("/earn")).toBe("Earn");
    expect(assistantPageLabel("/farm")).toBe("Farm");
    expect(assistantPageLabel("/trade/spot")).toBe("Spot trade");
    expect(assistantPageLabel("/")).toBe("Home");
  });
});
