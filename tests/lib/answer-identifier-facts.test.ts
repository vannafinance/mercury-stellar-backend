/**
 * An enumeration answer must arrive whole.
 *
 * ## The live failure this pins
 *
 * "show me the protocol contract addresses" returns fifteen addresses. The answer model is
 * told "at most 6 facts", obeyed it, and the card rendered six — while the other nine fell
 * through to the generic key/value facts grid below it. One answer, two presentations, and
 * the half in the nicely designed card was indistinguishable from the whole set unless you
 * happened to know there were fifteen.
 *
 * Loosening the prompt is not enough on its own: asking a model for the complete set is a
 * request, and a partial list of contract addresses is the one case where partial reads as
 * authoritative. So the set is completed deterministically from DATA, and these tests pin
 * the narrowness of that completion — it must not turn a figure answer into a contract dump.
 */

import { describe, expect, it } from "vitest";
import {
  completeIdentifierFacts,
  normalizeAnswer,
  type StructuredAnswer,
} from "@/lib/copilot/answer-schema";

const A = "CBBQQULN3XZDWDZG7D6VYD4UQKBGYH22DOFQEISKENCMZTYUPQ5LDXUO";
const B = "CAZLR6EHZXQNZJIFNP6F7SIJQC3P64MKHHQNZSSG5BNAEFCYTTGTDZXB";
const C = "CCSCBA4WSUMVGA4CWC7QKBZXXEL4TO2YCCFPGHX5SJCYKHQLQUKAVUAY";
const HASH = "a".repeat(64);

const answer = (facts: StructuredAnswer["facts"]): StructuredAnswer => ({
  headline: "Protocol contract addresses.",
  facts,
});

describe("completeIdentifierFacts", () => {
  it("THE LIVE BUG: adds the addresses the model left out of an enumeration", () => {
    const out = completeIdentifierFacts(answer([{ label: "registry", value: A }]), {
      registry: A,
      "account manager": B,
      "risk engine": C,
    });
    expect(out.facts.map((f) => f.value)).toEqual([A, B, C]);
    // The model's own fact keeps its position and label; additions follow in DATA order.
    expect(out.facts[0].label).toBe("registry");
    expect(out.facts[1].label).toBe("account manager");
  });

  it("leaves a figure answer completely alone", () => {
    // No identifier among the facts, so this is not an enumeration. A health-factor answer
    // must never grow a list of contract addresses because the payload happened to carry one.
    const original = answer([{ label: "health factor", value: "2.89", tone: "good" }]);
    const out = completeIdentifierFacts(original, { hf: "2.89", registry: A, oracle: B });
    expect(out).toEqual(original);
  });

  it("never duplicates a value the answer already rendered", () => {
    const out = completeIdentifierFacts(
      answer([
        { label: "registry", value: A },
        { label: "account manager", value: B },
      ]),
      { registry: A, "account manager": B },
    );
    expect(out.facts).toHaveLength(2);
  });

  it("matches on the value, not the label, so a relabelled fact is not repeated", () => {
    // The model writes its own labels; only the address identifies the row.
    const out = completeIdentifierFacts(answer([{ label: "the registry contract", value: A }]), {
      registry: A,
    });
    expect(out.facts).toHaveLength(1);
    expect(out.facts[0].label).toBe("the registry contract");
  });

  it("stops at 16 facts — the count the card was designed for", () => {
    const data: Record<string, string> = { first: A };
    for (let i = 0; i < 30; i++) {
      // Distinct, valid 56-char C-addresses. Base32 here is [A-Z2-7], so the varying part
      // has to be letters — digits 0, 1, 8 and 9 are not in the alphabet and would make
      // these fail `isIdentifierValue`, quietly turning the cap under test into a no-op.
      const a = String.fromCharCode(65 + (i % 26));
      const b = String.fromCharCode(65 + Math.floor(i / 26));
      data[`pool ${i}`] = `C${a}${b}${"A".repeat(53)}`;
    }
    const out = completeIdentifierFacts(answer([{ label: "first", value: A }]), data);
    expect(out.facts).toHaveLength(16);
  });

  it("counts a 64-char tx hash as an identifier too", () => {
    const out = completeIdentifierFacts(answer([{ label: "tx", value: HASH }]), {
      tx: HASH,
      registry: A,
    });
    expect(out.facts.map((f) => f.value)).toEqual([HASH, A]);
  });

  it("ignores non-identifier values in DATA", () => {
    const out = completeIdentifierFacts(answer([{ label: "registry", value: A }]), {
      registry: A,
      supply_apy_pct: "13.97",
      simulation_success: true,
      wad: "1000000000000000000",
      nested: { registry: B },
    });
    expect(out.facts).toHaveLength(1);
  });

  it("underscored DATA keys become readable labels, without the registry's 'optional'", () => {
    // The MCP registry marks entries `optional_*` to say the contract need not be deployed.
    // That is a note for whoever maintains the registry; rendered in the card it read as part
    // of the contract's name ("OPTIONAL TRACKING TOKEN"), which is noise and slightly wrong.
    const out = completeIdentifierFacts(answer([{ label: "registry", value: A }]), {
      registry: A,
      optional_tracking_token: B,
    });
    expect(out.facts[1].label).toBe("tracking token");
  });

  it("keeps 'optional' when it is part of the name rather than a prefix", () => {
    const out = completeIdentifierFacts(answer([{ label: "registry", value: A }]), {
      registry: A,
      "pool optional flag": B,
    });
    expect(out.facts[1].label).toBe("pool optional flag");
  });
});

describe("normalizeAnswer does not truncate an enumeration", () => {
  /**
   * This is where the addresses were actually being lost.
   *
   * The card is designed for sixteen facts, but the normaliser sliced every answer to six —
   * so even a model that returned all fifteen had nine of them dropped before the UI saw
   * them, and they reappeared in the generic facts grid below the card. The prompt was
   * rewritten twice chasing this; the prompt was never the ceiling.
   */
  const facts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      label: `pool ${i}`,
      value: `C${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}${"A".repeat(53)}`,
    }));

  it("THE LIVE BUG: fifteen facts survive normalisation", () => {
    const out = normalizeAnswer({ headline: "Addresses.", facts: facts(15) });
    expect(out?.facts).toHaveLength(15);
  });

  it("still caps at 16, so a runaway answer cannot flood the card", () => {
    const out = normalizeAnswer({ headline: "Addresses.", facts: facts(40) });
    expect(out?.facts).toHaveLength(16);
  });

  it("strips the registry's 'optional' prefix from model labels too", () => {
    const out = normalizeAnswer({
      headline: "Addresses.",
      facts: [{ label: "optional aquarius router", value: A }],
    });
    expect(out?.facts[0].label).toBe("aquarius router");
  });
});
