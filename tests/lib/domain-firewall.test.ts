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
});
