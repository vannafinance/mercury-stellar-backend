/**
 * A near or exact domain name sends the turn to investigation. The resolver is
 * stubbed here with the contract's answers; this file does not score distance.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateInvestigationJson: vi.fn(),
  resolveName: vi.fn(),
}));

vi.mock("@/lib/copilot/vertex", () => ({
  generateInvestigationJson: mocks.generateInvestigationJson,
}));
vi.mock("@/lib/copilot/intent/resolve-name", () => ({
  resolveName: mocks.resolveName,
}));

import { evaluateDomainFirewall, guardUserPrompt } from "@/lib/copilot/domain-firewall";
import { resetDomainClassifierCache } from "@/lib/copilot/domain-classifier";
import { resetTokenUsage } from "@/lib/copilot/token-budget";

const near = (id: string) => ({
  kind: "near" as const,
  candidates: [{ id, label: id, kind: "op", distance: 1 }],
});
const exact = (id: string) => ({
  kind: "exact" as const,
  candidates: [{ id, label: id, kind: "asset", distance: 0 }],
});

beforeEach(() => {
  vi.stubEnv("VERTEX_RESEARCH_MODEL", "gemini-3.7-flash");
  mocks.generateInvestigationJson.mockReset();
  mocks.resolveName.mockReset();
  mocks.resolveName.mockReturnValue({ kind: "none", candidates: [] });
  resetDomainClassifierCache();
  resetTokenUsage();
});

const opts = { subject: "user", signal: new AbortController().signal };

describe("a resolved domain word reaches investigation", () => {
  it.each([
    ["helth factor", "helth"],
    ["whats my positon", "positon"],
  ])("%s is allowed when %s is near a domain name", async (message, word) => {
    mocks.resolveName.mockImplementation((got: string) => got.toLowerCase() === word ? near(word) : { kind: "none", candidates: [] });
    expect(evaluateDomainFirewall(message).reason).toBe("allow:resolved_name");
    const verdict = await guardUserPrompt(message, opts);
    expect(verdict.allow).toBe(true);
    expect(mocks.generateInvestigationJson).not.toHaveBeenCalled();
  });

  it("borow 50 xlm reaches investigation", async () => {
    mocks.resolveName.mockImplementation((got: string) => got.toLowerCase() === "borow" ? near("borrow") : { kind: "none", candidates: [] });
    const verdict = await guardUserPrompt("borow 50 xlm", opts);
    expect(verdict.allow).toBe(true);
    expect(mocks.generateInvestigationJson).not.toHaveBeenCalled();
  });

  it("allows an exact asset token the cheap list missed", async () => {
    mocks.resolveName.mockImplementation((got: string) => got.toLowerCase() === "xlm" ? exact("XLM") : { kind: "none", candidates: [] });
    const verdict = await guardUserPrompt("zz xlm", opts);
    expect(verdict.allow).toBe(true);
  });

  it("still refuses a poem when no word is a domain name and the classifier says no", async () => {
    mocks.generateInvestigationJson.mockResolvedValue({ kind: "off_domain", sourceQuote: null });
    const verdict = await guardUserPrompt("write me a poem", opts);
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.message).toMatch(/Vanna Finance/);
  });

  it("sends the turn to investigation when the classifier errors", async () => {
    mocks.generateInvestigationJson.mockRejectedValue(new Error("vertex down"));
    const verdict = await guardUserPrompt("write me a poem", opts);
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toBe("classifier_unavailable");
  });

  it("still trips the abuse wire before a domain word can save it", async () => {
    mocks.resolveName.mockReturnValue(exact("XLM"));
    const verdict = await guardUserPrompt("write me a python function to sort a list of XLM", opts);
    expect(verdict.allow).toBe(false);
    expect(mocks.generateInvestigationJson).not.toHaveBeenCalled();
  });
});
