import { describe, it, expect } from "vitest";
import { evaluateDomainFirewall } from "@/lib/copilot/domain-firewall";

describe("the firewall reads plurals and inflections, not just dictionary singulars", () => {
  /**
   * The allowlist matched product nouns with `\b` on both ends, and a trailing `\b` after
   * a singular stem does not match its plural — `position\b` fails on "positions" because
   * `s` is a word character. So "…my current open position" was answered and "…my current
   * open positions" was refused with "I only help with Vanna Finance on Stellar", about a
   * Vanna position, on the Vanna copilot page.
   *
   * Every entry below was refused before this fix.
   */
  const wronglyRefused = [
    "tell me all my current open positions",
    "show my positions",
    "what are my open positions",
    "list my positions",
    "what are my current positions",
    "show my portfolio",
    "what is my portfolio worth",
    "show me my holdings",
    "what is my exposure",
    "show me the pools",
    "list all pools",
    "what is liquidation",
    "am i close to liquidation",
    "what are my balances",
    "show my balances",
    "what are the prices",
    "what are my open trades",
    "what can i do here",
  ];

  for (const ask of wronglyRefused) {
    it(`allows "${ask}"`, () => {
      expect(evaluateDomainFirewall(ask).allow, ask).toBe(true);
    });
  }

  it("still allows the singular, which always worked", () => {
    expect(evaluateDomainFirewall("tell me my all current open position").allow).toBe(true);
  });

  it("does not let a longer word be shadowed by a shorter stem in the alternation", () => {
    // "suppl" sits in the vocabulary for "supplies"/"supplied". Tried before the longer
    // entries it would match "suppl" and then fail `\b` on the following "i".
    for (const ask of ["my supplies", "what did i supply", "what have i supplied"]) {
      expect(evaluateDomainFirewall(ask).allow, ask).toBe(true);
    }
  });

  it("keeps general chat out — widening the vocabulary must not open the door", () => {
    for (const ask of [
      "what is the capital of france",
      "who won the world cup",
      "give me a lasagna recipe",
      "write me a python function to sort a list",
      "how do i tie a tie",
      "who is the president",
    ]) {
      expect(evaluateDomainFirewall(ask).allow, ask).toBe(false);
    }
  });
});

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

  it("allows protocol / contract address product reads", () => {
    /**
     * Observed failure: the palette prompt "List protocol addresses" (and close variants
     * the router already maps to `vanna_list_protocol_addresses`) was refused because
     * "list"/"show"/"what" tripped the off-domain question rule while protocol/address
     * vocabulary was missing from the allowlist.
     */
    for (const ask of [
      "List protocol addresses",
      "list addresses",
      "show protocol addresses",
      "what are the contract addresses",
      "list contract addresses",
      "what is the registry",
      "protocol addresses",
    ]) {
      expect(evaluateDomainFirewall(ask).allow, ask).toBe(true);
    }
  });

  it("still refuses bare address / unrelated address questions", () => {
    expect(evaluateDomainFirewall("what is your home address").allow).toBe(false);
    expect(evaluateDomainFirewall("what's the address of the white house").allow).toBe(false);
  });
});
