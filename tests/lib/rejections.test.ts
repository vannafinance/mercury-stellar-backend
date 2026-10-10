import { describe, expect, it } from "vitest";
import { describeRejections, groupRejections, soleRejection } from "@/lib/copilot/investigation/rejections";

/**
 * 8 Oct, live: "borrow the maximum I can safely" listed the same missing answer three times, once per asset.
 */
const floor = "borrowing to the floor needs the health-factor floor you want kept, above the 1.1 liquidation line.";
const rows = [
  { label: "Borrow SOUSDC to safe margin capacity", reason: `borrow SOUSDC: ${floor}`, cause: floor },
  { label: "Borrow XLM to safe margin capacity", reason: `borrow XLM: ${floor}`, cause: floor },
  { label: "Borrow BLUSDC to safe margin capacity", reason: `borrow BLUSDC: ${floor}`, cause: floor },
];

describe("groupRejections", () => {
  it("lists shapes refused for one cause together, with the cause once", () => {
    const groups = groupRejections(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].labels).toEqual(rows.map((row) => row.label));
    expect(groups[0].cause).toBe(floor);
  });
  it("keeps different causes apart, in the order they first appeared", () => {
    const groups = groupRejections([
      { label: "Lend AQUA", reason: "lend AQUA: AQUA has no Earn pool.", cause: "AQUA has no Earn pool." },
      ...rows,
      { label: "Lend EURC", reason: "lend EURC: EURC has no Earn pool.", cause: "EURC has no Earn pool." },
    ]);
    expect(groups.map((group) => group.cause)).toEqual(["AQUA has no Earn pool.", floor, "EURC has no Earn pool."]);
  });
  it("falls back to the reason when a row carries no cause", () => {
    expect(groupRejections([{ label: "A", reason: "same." }, { label: "B", reason: "same." }])).toEqual([{ labels: ["A", "B"], cause: "same." }]);
  });
});

describe("describeRejections", () => {
  it("says the shared cause once", () => {
    const text = describeRejections(rows);
    expect(text.match(/needs the health-factor floor/g)).toHaveLength(1);
    expect(text).toContain("Borrow SOUSDC to safe margin capacity, Borrow XLM to safe margin capacity, Borrow BLUSDC to safe margin capacity - borrowing to the floor");
    expect(text.endsWith(".")).toBe(false);
  });
  it("shows at most three causes", () => {
    const many = ["a", "b", "c", "d"].map((x) => ({ label: x, reason: `${x}.`, cause: `${x}.` }));
    expect(describeRejections(many).split("; ")).toHaveLength(3);
  });
});

describe("soleRejection", () => {
  it("says a cause shared by every refused shape once, to the person, with no count in front", () => {
    expect(soleRejection(rows)).toBe(floor.replace(/\.$/, "").replace(/^b/, "B"));
  });
  it("keeps the label when only one shape was refused", () => {
    expect(soleRejection([{ label: "Supply 10 BLUSDC to Blend", reason: "supply blend BLUSDC: Blend has no AQUSDC reserve.", cause: "Blend has no AQUSDC reserve." }]))
      .toBe("Supply 10 BLUSDC to Blend - Blend has no AQUSDC reserve");
  });
  it("is null when the causes differ, so the longer listing is used", () => {
    expect(soleRejection([{ label: "A", reason: "x.", cause: "x." }, { label: "B", reason: "y.", cause: "y." }])).toBeNull();
  });
});
