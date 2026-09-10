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
import { guardUserPrompt } from "@/lib/copilot/domain-firewall";
import { recordTokenUsage, resetTokenUsage } from "@/lib/copilot/token-budget";

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
    mocks.generateInvestigationJson.mockResolvedValue({ in_domain: true, reason: "product" });
    const signal = new AbortController().signal;
    await expect(classifyDomain("obscure phrasing about the protocol", signal)).resolves.toEqual({
      in_domain: true, reason: "product",
    });
    await expect(classifyDomain("Obscure phrasing about the protocol", signal)).resolves.toEqual({
      in_domain: true, reason: "product",
    });
    expect(mocks.generateInvestigationJson).toHaveBeenCalledOnce();
    expect(mocks.generateInvestigationJson.mock.calls[0][4]).toBe("LOW");
  });

  it("fails closed when Vertex is unavailable", async () => {
    mocks.generateInvestigationJson.mockRejectedValue(new Error("vertex down"));
    await expect(classifyOrFallback("trivia", new AbortController().signal, "user", false))
      .resolves.toEqual({ in_domain: false, reason: "classifier_unavailable" });
  });

  it("does not call the classifier when the cheap allowlist already matched", async () => {
    await expect(classifyOrFallback("lend 10 XLM", new AbortController().signal, "user", true))
      .resolves.toEqual({ in_domain: true, reason: "cheap_allow" });
    expect(mocks.generateInvestigationJson).not.toHaveBeenCalled();
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
    mocks.generateInvestigationJson.mockResolvedValue({ in_domain: false, reason: "trivia" });
    const verdict = await guardUserPrompt("what is the capital of france", {
      subject: "user",
      signal: new AbortController().signal,
    });
    expect(verdict.allow).toBe(false);
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
