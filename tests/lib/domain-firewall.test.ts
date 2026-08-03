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

  it("allows the ways people actually ask about the page", () => {
    for (const q of [
      "What am I looking at on this page?",
      "what is this?",
      "explain this screen",
      "what does this mean",
      "walk me through this page",
    ]) {
      expect(evaluateDomainFirewall(q).allow, q).toBe(true);
    }
  });

  it("allows a deictic question when a page is attached", () => {
    const q = "why is my number red?";
    expect(evaluateDomainFirewall(q).allow).toBe(false);
    expect(evaluateDomainFirewall(q, { hasPageContext: true }).allow).toBe(true);
  });

  it("a page does not turn it into an open chatbot", () => {
    for (const q of ["what is the capital of France?", "write me a python function"]) {
      expect(evaluateDomainFirewall(q, { hasPageContext: true }).allow, q).toBe(false);
    }
  });

  it("allows lend", () => {
    expect(evaluateDomainFirewall("lend 10 XLM").allow).toBe(true);
  });

  it("allows create / connect wallet", () => {
    expect(evaluateDomainFirewall("create a wallet").allow).toBe(true);
    expect(evaluateDomainFirewall("create vanna wallet").allow).toBe(true);
    expect(evaluateDomainFirewall("connect wallet").allow).toBe(true);
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
