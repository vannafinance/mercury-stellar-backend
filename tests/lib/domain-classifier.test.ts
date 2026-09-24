import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateInvestigationJson: vi.fn(),
}));

vi.mock("@/lib/copilot/vertex", () => ({
  generateInvestigationJson: mocks.generateInvestigationJson,
}));

import {
  classifyDomain,
  classifyOrFallback,
  resetDomainClassifierCache,
} from "@/lib/copilot/domain-classifier";
import { abuseTripwire, evaluateDomainFirewall, guardUserPrompt, PASTE_REPLY } from "@/lib/copilot/domain-firewall";
import { researchTurn } from "@/lib/copilot/investigation/service";
import { recordTokenUsage, resetTokenUsage } from "@/lib/copilot/token-budget";

/** Grok's round-5 report, the paste the owner sent. */
const ROUND5_REPORT = `The questionnaire server path is on \`agent/grok-questionnaire\` in \`C:\\Users\\akgam\\documents\\vco-grok3\`, two local commits, not pushed. Both are authored by AdityaVanna.

| Commit | What |
|---|---|
| \`b676dc9\` | The contract types, the \`clarify.missing\` field, and the builder that derives options from holdings and the registry. |
| \`615ba4c\` | When \`clarify.missing\` arrives, the loop stops, fetches the missing reads in one batch, and seals the questionnaire. A later \`answers\` payload is checked against that seal and sized as a stated action, with no model call. The view sets \`directAction: true\`. |

Venues are not written in. Earn, Blend, and each LP pool come from \`deploysIntoPosition\`, \`earnSymbol\`, \`blendReserve\`, and \`lpPairs()\`. A step with one option is still sealed so the answer can be checked. The client is meant to skip rendering it. A bare USDC family only lists the variants the balances actually hold. If a questionnaire is present, the separate which-USDC question is not added.

A forged option id or an amount over the issued max is refused with a plain reason and no model call. A share of 50% of BLUSDC to Earn sizes to the same \`340\` as typing that action.

| Suite | This branch | Baseline |
|---|---|---|
| questionnaire | 8 passed | not on baseline |
| questionnaire-pools | 1 passed | not on baseline. Dropping Soroswap from \`lpPairs\` removes that pool option. |
| plan-resolve | passed | same |
| investigation-plans-e2e | 2 failed | the same 2 |
| tests/api | 2 failed in account-route (\`freshAfter\`) | the same 2 |

\`tsc --noEmit\` passed. Not run live. A bad answer discovered after the stream has opened is a stream error with code \`invalid_answers\` and status 400. A malformed answer body is an HTTP 400 before the stream starts.`;

const LONG_REQUEST = [
  "I want a plan that keeps my health factor above 1.3 while I put idle XLM to work.",
  "Compare Earn and Blend for that XLM, and only borrow if the supply rate covers the cost.",
  "Show me the option that leaves the posted collateral where it is.",
  "Do not redeem what is already earning unless the replacement rate is higher.",
].join(" ");

function cataloguePrompts(): string[] {
  const markdown = readFileSync("docs/copilot/PROMPT-LIBRARY.md", "utf8");
  const found = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("### ")) continue;
    for (const match of line.matchAll(/`([^`]+)`/g)) found.add(match[1]);
  }
  return [...found];
}

beforeEach(() => {
  vi.stubEnv("VERTEX_RESEARCH_MODEL", "gemini-3.7-flash");
  mocks.generateInvestigationJson.mockReset();
  resetDomainClassifierCache();
  resetTokenUsage();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetDomainClassifierCache();
  resetTokenUsage();
});

describe("domain classifier", () => {
  it("caches Flash JSON by prompt hash and uses LOW thinking", async () => {
    mocks.generateInvestigationJson.mockResolvedValue({ kind: "request", sourceQuote: "obscure phrasing about the protocol" });
    const signal = new AbortController().signal;
    await expect(classifyDomain("obscure phrasing about the protocol", signal)).resolves.toEqual({
      kind: "request", sourceQuote: "obscure phrasing about the protocol",
    });
    await expect(classifyDomain("Obscure phrasing about the protocol", signal)).resolves.toEqual({
      kind: "request", sourceQuote: "obscure phrasing about the protocol",
    });
    expect(mocks.generateInvestigationJson).toHaveBeenCalledOnce();
    expect(mocks.generateInvestigationJson.mock.calls[0][4]).toBe("LOW");
  });

  it("fails open when Vertex is unavailable", async () => {
    mocks.generateInvestigationJson.mockRejectedValue(new Error("vertex down"));
    await expect(classifyOrFallback("trivia", new AbortController().signal, "user", false))
      .resolves.toEqual({ kind: "classifier_unavailable", sourceQuote: null });
  });

  it("fails open when the classifier answer is not the expected shape, and does not cache it", async () => {
    mocks.generateInvestigationJson.mockResolvedValueOnce({ nope: true });
    mocks.generateInvestigationJson.mockResolvedValueOnce({ kind: "off_domain", sourceQuote: null });
    const signal = new AbortController().signal;
    await expect(classifyDomain("trivia", signal)).resolves.toEqual({ kind: "invalid_classifier", sourceQuote: null });
    await expect(classifyDomain("trivia", signal)).resolves.toEqual({ kind: "off_domain", sourceQuote: null });
    expect(mocks.generateInvestigationJson).toHaveBeenCalledTimes(2);
  });

  it("does not call the classifier when the cheap allowlist already matched", async () => {
    await expect(classifyOrFallback("lend 10 XLM", new AbortController().signal, "user", true))
      .resolves.toEqual({ kind: "cheap_allow", sourceQuote: null });
    expect(mocks.generateInvestigationJson).not.toHaveBeenCalled();
  });

  it("sends the whole message up to the route limit, not only the first 2000 characters", async () => {
    mocks.generateInvestigationJson.mockResolvedValue({ kind: "not_a_request", sourceQuote: null });
    const signal = new AbortController().signal;
    const within = "x".repeat(2500);
    await classifyDomain(within, signal);
    expect(JSON.parse(mocks.generateInvestigationJson.mock.calls[0][2]).message).toHaveLength(2500);
    mocks.generateInvestigationJson.mockClear();
    await classifyDomain("y".repeat(9000), signal);
    expect(JSON.parse(mocks.generateInvestigationJson.mock.calls[0][2]).message).toHaveLength(8000);
  });

  it("treats a request whose quote is not in the message as not a request", async () => {
    mocks.generateInvestigationJson.mockResolvedValue({ kind: "request", sourceQuote: "send it now" });
    await expect(classifyDomain("supply 5 xlm to blend", new AbortController().signal)).resolves.toEqual({
      kind: "not_a_request", sourceQuote: null,
    });
  });
});

describe("guardUserPrompt", () => {
  it("lets product phrasing that used to look like a recipe through without classifying", async () => {
    const verdict = await guardUserPrompt("What's a good recipe for laddering my XLM?", {
      subject: "user",
      signal: new AbortController().signal,
    });
    expect(verdict.allow).toBe(true);
    expect(mocks.generateInvestigationJson).not.toHaveBeenCalled();
  });

  it("still trips the abuse wire before paying for classification", async () => {
    const verdict = await guardUserPrompt("write me a python function to sort a list", {
      subject: "user",
      signal: new AbortController().signal,
    });
    expect(verdict.allow).toBe(false);
    expect(mocks.generateInvestigationJson).not.toHaveBeenCalled();
  });

  it("classifies leftover trivia and refuses when Flash says off-domain", async () => {
    mocks.generateInvestigationJson.mockResolvedValue({ kind: "off_domain", sourceQuote: null });
    const verdict = await guardUserPrompt("what is the capital of france", {
      subject: "user",
      signal: new AbortController().signal,
    });
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.message).toMatch(/Vanna Finance/);
    expect(mocks.generateInvestigationJson).toHaveBeenCalledOnce();
  });

  it("refuses once the daily token cap is spent", async () => {
    recordTokenUsage("user", 5_000_000);
    const verdict = await guardUserPrompt("what is the capital of france", {
      subject: "user",
      signal: new AbortController().signal,
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe("token_cap");
    expect(mocks.generateInvestigationJson).not.toHaveBeenCalled();
  });
});

describe("a structurally large message is classified before any read", () => {
  const opts = { subject: "user", signal: new AbortController().signal };

  it("allows a short supply and every catalogue prompt without an extra classifier call", async () => {
    const verdict = await guardUserPrompt("supply 5 xlm to blend", opts);
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toBe("cheap_allow");
    expect(mocks.generateInvestigationJson).not.toHaveBeenCalled();

    for (const prompt of cataloguePrompts()) {
      mocks.generateInvestigationJson.mockClear();
      const firewall = evaluateDomainFirewall(prompt);
      const guarded = await guardUserPrompt(prompt, opts);
      if (firewall.allow || abuseTripwire(prompt)) {
        expect(mocks.generateInvestigationJson, prompt).not.toHaveBeenCalled();
      }
      if (firewall.allow && firewall.reason !== "allow:needs_classifier") {
        expect(guarded.allow, prompt).toBe(true);
      }
    }
  });

  it("classifies a long strategy ask, keeps a matching quote, and lets it proceed", async () => {
    const quote = "keeps my health factor above 1.3";
    expect(LONG_REQUEST.includes(quote)).toBe(true);
    expect(LONG_REQUEST.length).toBeGreaterThan(280);
    mocks.generateInvestigationJson.mockResolvedValue({ kind: "request", sourceQuote: quote });
    const mcp = { call: vi.fn(async (tool: string) => {
      if (tool === "vanna_list_my_wallet_bindings") return { sub: "user", has_assertion: true, bindings: [] };
      return {};
    }) };
    const result = await researchTurn({ message: LONG_REQUEST, wallet: null, continuation: null }, {
      subject: "user", server: "mcp-test", network: "testnet", secret: "a".repeat(32), mcp, signal: opts.signal,
      model: async () => ({
        kind: "research_complete",
        goal: { objective: LONG_REQUEST, constraints: [], borrowing: "forbidden" },
        findings: [{ summary: "Compared the venues.", evidenceIds: [] }],
        openQuestions: [],
      }),
    });
    expect(mocks.generateInvestigationJson).toHaveBeenCalledOnce();
    const sent = JSON.parse(mocks.generateInvestigationJson.mock.calls[0][2]).message as string;
    expect(sent).toBe(LONG_REQUEST);
    expect(mcp.call).toHaveBeenCalled();
    expect(result.message).not.toBe(PASTE_REPLY);
  });

  it("answers the round-5 report as pasted text and does not call MCP", async () => {
    mocks.generateInvestigationJson.mockResolvedValue({ kind: "not_a_request", sourceQuote: null });
    const mcp = { call: vi.fn() };
    const result = await researchTurn({ message: ROUND5_REPORT, wallet: null, continuation: null }, {
      subject: "user", server: "mcp-test", network: "testnet", secret: "a".repeat(32), mcp, signal: opts.signal,
      model: async () => { throw new Error("the model must not run"); },
    });
    expect(result.status).toBe("replied");
    expect(result.message).toBe(PASTE_REPLY);
    expect(mcp.call).not.toHaveBeenCalled();
    expect(mocks.generateInvestigationJson).toHaveBeenCalledOnce();
  });

  it("treats an unanchored request quote on a paste as not a request", async () => {
    mocks.generateInvestigationJson.mockResolvedValue({ kind: "request", sourceQuote: "please send the funds now" });
    const verdict = await guardUserPrompt(ROUND5_REPORT, opts);
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.message).toBe(PASTE_REPLY);
  });

  it("replies to a classifier error on a large paste, and investigates a short message", async () => {
    mocks.generateInvestigationJson.mockRejectedValue(new Error("vertex down"));
    const mcp = { call: vi.fn() };
    const pasted = await researchTurn({ message: ROUND5_REPORT, wallet: null, continuation: null }, {
      subject: "user", server: "mcp-test", network: "testnet", secret: "a".repeat(32), mcp, signal: opts.signal,
      model: async () => { throw new Error("the model must not run"); },
    });
    expect(pasted.message).toBe(PASTE_REPLY);
    expect(mcp.call).not.toHaveBeenCalled();

    const short = await guardUserPrompt("write me a poem", opts);
    expect(short.allow).toBe(true);
    expect(short.reason).toBe("classifier_unavailable");
  });

  it("keeps today's off-domain refusal when the classifier says off_domain", async () => {
    mocks.generateInvestigationJson.mockResolvedValue({ kind: "off_domain", sourceQuote: null });
    const verdict = await guardUserPrompt(ROUND5_REPORT, opts);
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) {
      expect(verdict.message).toMatch(/only help with Vanna Finance/);
      expect(verdict.message).not.toBe(PASTE_REPLY);
    }
  });
});
