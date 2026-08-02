import { describe, it, expect } from "vitest";
import { evaluateDomainFirewall } from "@/lib/copilot/domain-firewall";

describe("domain firewall", () => {
  it("blocks coding abuse", () => {
    const r = evaluateDomainFirewall("write me a python function to sort a list");
    expect(r.allow).toBe(false);
  });

  it("blocks homework", () => {
    const r = evaluateDomainFirewall("write me an essay on climate change");
    expect(r.allow).toBe(false);
  });

  it("allows health factor", () => {
    expect(evaluateDomainFirewall("what is my health factor").allow).toBe(true);
  });

  it("allows multi-leg farm", () => {
    expect(
      evaluateDomainFirewall(
        "park 20 XLM for yield then farm 10 BLUSDC at 2x keep HF above 1.4",
      ).allow,
    ).toBe(true);
  });

  it("allows screen question", () => {
    expect(evaluateDomainFirewall("what is being shown on my screen").allow).toBe(true);
  });

  it("allows lend", () => {
    expect(evaluateDomainFirewall("lend 10 XLM").allow).toBe(true);
  });

  it("blocks bare language asks for free coding", () => {
    expect(evaluateDomainFirewall("help me with python").allow).toBe(false);
    expect(evaluateDomainFirewall("help me code a website").allow).toBe(false);
  });

  it("blocks off-domain long ramble", () => {
    const r = evaluateDomainFirewall(
      "I need a long explanation of European medieval history for my class presentation tomorrow please write something detailed",
    );
    expect(r.allow).toBe(false);
  });
});
