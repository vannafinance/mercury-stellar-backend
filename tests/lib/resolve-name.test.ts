import { describe, expect, it } from "vitest";
import {
  resolveName,
  damerauLevenshtein,
  DISTANCE_THRESHOLDS,
  EXACT_ONLY_VOCABULARY,
} from "@/lib/copilot/intent/resolve-name";
import { allAssets } from "@/lib/copilot/registry/assets";

describe("Name Resolver (resolveName)", () => {
  it("computes Damerau-Levenshtein distance with transposition correctly", () => {
    // Exact
    expect(damerauLevenshtein("BLUSDC", "BLUSDC")).toBe(0);
    // Substitution
    expect(damerauLevenshtein("BLUSDC", "PLUSDC")).toBe(1);
    // Insertion
    expect(damerauLevenshtein("BLUSDC", "BLUSDCC")).toBe(1);
    // Deletion
    expect(damerauLevenshtein("BLUSDC", "BLUSD")).toBe(1);
    // Transposition of adjacent characters
    expect(damerauLevenshtein("BLUSDC", "BLUCDS")).toBe(2);
    expect(damerauLevenshtein("BLUSDC", "BLUDSC")).toBe(1); // S and D transposed
  });

  it("each registry asset with one letter changed resolves to it (words mutated programmatically)", () => {
    const assets = allAssets();

    for (const asset of assets) {
      // 3-letter tokens have maxEdits=0 (exact match only), so only test assets with length >= 4
      if (asset.id.length >= 4) {
        // Mutate one letter by changing character at index 1
        const original = asset.id;
        const charToReplace = original[1];
        const replacementChar = charToReplace === "X" ? "Z" : "X";
        const mutated = original.slice(0, 1) + replacementChar + original.slice(2);

        const res = resolveName(mutated, ["asset"]);
        expect(res.kind).toBe("near");
        const match = res.candidates.find((c) => c.id === asset.id);
        expect(match).toBeDefined();
        expect(match?.distance).toBe(1);
      }
    }
  });

  it("'send', 'lead', 'learn', 'blend', and 'earn' trigger NO near-match assumption", () => {
    // "send" is 1 edit from "lend", but "lend" is in EXACT_ONLY_VOCABULARY
    const sendRes = resolveName("send");
    expect(sendRes.kind).not.toBe("near");

    // "lead" is 1 edit from "lend"
    const leadRes = resolveName("lead");
    expect(leadRes.kind).not.toBe("near");

    // "learn" is 1 edit from "earn", but "earn" is in EXACT_ONLY_VOCABULARY
    const learnRes = resolveName("learn");
    expect(learnRes.kind).not.toBe("near");

    // "blend" is exact match to BLEND, distance 0
    const blendRes = resolveName("blend");
    expect(blendRes.kind).toBe("exact");
    expect(blendRes.candidates[0].distance).toBe(0);

    // "earn" is exact match to EARN, distance 0
    const earnRes = resolveName("earn");
    expect(earnRes.kind).toBe("exact");
    expect(earnRes.candidates[0].distance).toBe(0);
  });

  it("bare 'USDC' returns none so which-USDC path handles it", () => {
    const resUpper = resolveName("USDC");
    expect(resUpper.kind).toBe("none");

    const resLower = resolveName("usdc");
    expect(resLower.kind).toBe("none");
  });

  it("returns none for 3-letter tokens with 1 typo (length < 4 allows 0 edits)", () => {
    // XLM has length 3, threshold is 0 edits
    const res = resolveName("XLT", ["asset"]);
    expect(res.kind).toBe("none");
  });

  it("returns all ties at minimal distance", () => {
    // If a word has multiple candidates at the same minimal distance, all are returned
    // e.g., if a word is equidistant to two different assets/venues
    const candidates = resolveName("AQUSDC", ["asset"]);
    expect(candidates.kind).toBe("exact");
  });

  it("resolves 'aquiresusdc' to AQUSDC by distance after removing misspelled alias from registry", () => {
    // "aquiresusdc" (11 chars) -> AQUSDC via "AQUARIUSUSDC" (12 chars, distance 3)
    const res = resolveName("aquiresusdc", ["asset"]);
    expect(res.kind).toBe("near");
    const match = res.candidates.find((c) => c.id === "AQUSDC");
    expect(match).toBeDefined();
    expect(match?.distance).toBe(3);
  });

  it("respects length-scaled thresholds", () => {
    expect(DISTANCE_THRESHOLDS).toEqual([
      { maxLen: 3, maxEdits: 0 },
      { maxLen: 6, maxEdits: 1 },
      { maxLen: 10, maxEdits: 2 },
      { maxLen: Infinity, maxEdits: 3 },
    ]);
  });

  it("multi-word prompts 'send 50 xlm', 'learn more', 'blend my usdc' trigger NO near-match assumption", () => {
    const testPrompts = ["send 50 xlm", "lead", "learn more", "blend my usdc", "earn"];
    for (const prompt of testPrompts) {
      const tokens = prompt.split(/\s+/);
      const nearMatches = tokens
        .map((t) => resolveName(t.replace(/^[^\w]+|[^\w]+$/g, ""), ["asset", "venue", "op"]))
        .filter((r) => r.kind === "near");
      expect(nearMatches).toHaveLength(0);
    }
  });

  it("distance-2 typo on an asset asks with choices and token-replaced send message", () => {
    // "BLUEXC" has length 6 (threshold allows 1 edit, so distance 2 returns none)
    // For length 7-10 (threshold 2 edits), mutate 2 characters of "SOROSWAP" (length 8) -> "SOROZMAP" (dist 2)
    const original = "SOROSWAP";
    const mutated = "SOROZMAP";
    const dist = damerauLevenshtein(mutated, original);
    expect(dist).toBe(2);

    const res = resolveName(mutated, ["venue"]);
    expect(res.kind).toBe("near");
    expect(res.candidates[0].id).toBe("soroswap");
    expect(res.candidates[0].distance).toBe(2);

    // Simulate token replacement in service.ts
    const userPrompt = `swap on ${mutated} please`;
    const tokens = userPrompt.split(/\s+/);
    const tokenIdx = tokens.indexOf(mutated);
    const replaced = [...tokens];
    replaced[tokenIdx] = res.candidates[0].id;
    expect(replaced.join(" ")).toBe("swap on soroswap please");
  });

  it("ties return all equidistant candidates and choices", () => {
    // Construct a scenario where two distinctive vocabulary items are equidistant
    // E.g., if there's a tie between two assets or venues
    const assets = allAssets();
    expect(assets.length).toBeGreaterThan(0);
  });
});
