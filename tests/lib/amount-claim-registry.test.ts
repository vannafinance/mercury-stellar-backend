import { describe, expect, it } from "vitest";
import {
  ClaimRegistry,
  collectStandardConstraints,
  findAmount,
  findAmountMatch,
  matchMinHealthFactor,
  routeMessage,
} from "@/lib/copilot/router";

describe("F1 Mechanism: Constraint span claiming and amount isolation", () => {
  it.each([
    {
      prompt: "deploy my idle funds into blend keeping HF above 1.4",
      expectedFloor: 1.4,
      expectedAmount: null,
    },
    {
      prompt: "supply my idle XLM to blend keeping health factor above 1.5",
      expectedFloor: 1.5,
      expectedAmount: null,
    },
    {
      prompt: "deposit my idle XLM into blend without my HF dropping below 1.6",
      expectedFloor: 1.6,
      expectedAmount: null,
    },
    {
      prompt: "lend my idle XLM keeping HF above 2",
      expectedFloor: 2,
      expectedAmount: null,
    },
    {
      prompt: "lend 50 XLM keeping HF above 1.4",
      expectedFloor: 1.4,
      expectedAmount: 50,
    },
    // Un-enumerated phrasing 1: explicit amount with non-standard floor phrase
    {
      prompt: "lock 75 XLM with minimum health factor 1.85",
      expectedFloor: 1.85,
      expectedAmount: 75,
    },
    // Un-enumerated phrasing 2: unsized action with non-standard floor phrase
    {
      prompt: "put my idle XLM into blend maintaining health factor at least 1.75",
      expectedFloor: 1.75,
      expectedAmount: null,
    },
  ])("correctly separates floor and amount for: $prompt", ({ prompt, expectedFloor, expectedAmount }) => {
    const registry = new ClaimRegistry();
    collectStandardConstraints(prompt, registry);

    const floor = matchMinHealthFactor(prompt);
    expect(floor).not.toBeNull();
    expect(floor?.value).toBe(expectedFloor);

    const amountMatch = findAmountMatch(prompt, registry);
    const amountVal = amountMatch?.value ?? null;
    expect(amountVal).toBe(expectedAmount);

    if (amountMatch && floor) {
      // Floor span and amount span must never overlap or be the same span
      const overlap = Math.max(floor.start, amountMatch.start) < Math.min(floor.end, amountMatch.end);
      expect(overlap).toBe(false);
      expect(floor.start === amountMatch.start && floor.end === amountMatch.end).toBe(false);
    }

    // Direct routeMessage test: amount must match expectedAmount
    const routed = routeMessage(prompt);
    if (routed.kind === "write") {
      expect(routed.amount ?? null).toBe(expectedAmount);
    }
  });

  it("ensures floor span and amount span are strictly disjoint in ClaimRegistry", () => {
    const prompt = "lend 50 XLM keeping HF above 1.4";
    const registry = new ClaimRegistry();
    collectStandardConstraints(prompt, registry);

    const floor = matchMinHealthFactor(prompt)!;
    const amountMatch = findAmountMatch(prompt, registry)!;

    expect(floor.value).toBe(1.4);
    expect(amountMatch.value).toBe(50);

    const claims = registry.getClaims();
    const floorClaim = claims.find((c) => c.kind === "min_health_factor");
    const amountClaim = claims.find((c) => c.kind === "amount");

    expect(floorClaim).toBeDefined();
    expect(amountClaim).toBeDefined();
    expect(floorClaim?.start).toBe(floor.start);
    expect(floorClaim?.end).toBe(floor.end);
    expect(amountClaim?.start).toBe(amountMatch.start);
    expect(amountClaim?.end).toBe(amountMatch.end);

    // Floor span is [12, 32], Amount span is [5, 7]
    expect(amountClaim!.end).toBeLessThanOrEqual(floorClaim!.start);
  });
});
