import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_DEFAULTS, MODEL_RETIREMENTS, RETIREMENT_WARNING_DAYS, retirementStatus, usableModels,
} from "@/lib/copilot/model-registry";
import { copilotConfig } from "@/lib/copilot/config";

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

afterEach(() => vi.unstubAllEnvs());

describe("model registry", () => {
  it("never ships a default that is retired or about to be (this is the early warning)", () => {
    const shipped = [MODEL_DEFAULTS.research, ...MODEL_DEFAULTS.fallback, MODEL_DEFAULTS.social];
    for (const model of shipped) {
      const status = retirementStatus(model);
      expect(status.state, `${model} retires ${status.retiresOn} (${status.daysLeft} days): move the default in model-registry.ts`).toBe("ok");
    }
  });

  it("moves through ok, retiring and retired around a published date", () => {
    const retires = "2027-01-28";
    expect(MODEL_RETIREMENTS["gemini-3.7-flash"]).toBe(retires);
    expect(retirementStatus("gemini-3.7-flash", day("2026-10-06")).state).toBe("ok");
    const soon = retirementStatus("gemini-3.7-flash", day(retires) - (RETIREMENT_WARNING_DAYS - 1) * 86_400_000);
    expect(soon).toMatchObject({ state: "retiring", retiresOn: retires });
    expect(retirementStatus("gemini-3.7-flash", day(retires)).state).toBe("retired");
    expect(retirementStatus("gemini-3.7-flash", day("2027-02-15")).state).toBe("retired");
  });

  it("does not claim a model with no published date is permanent or retiring", () => {
    expect(retirementStatus("gemini-9.9-flash", day("2030-01-01"))).toEqual({ state: "ok", retiresOn: null, daysLeft: null });
  });

  it("drops a retired model from the candidates, and keeps the list when every one is retired", () => {
    const after = day("2027-02-01");
    expect(usableModels(["gemini-3.7-flash", "gemini-3.5-flash"], after)).toEqual(["gemini-3.5-flash"]);
    expect(usableModels(["gemini-3.6-flash", "gemini-3.7-flash"], after)).toEqual(["gemini-3.6-flash", "gemini-3.7-flash"]);
    expect(usableModels(["gemini-3.7-flash", "gemini-3.5-flash"], day("2026-10-06"))).toEqual(["gemini-3.7-flash", "gemini-3.5-flash"]);
  });
});

describe("copilot config reads its models from the registry, and an env var overrides it", () => {
  it("uses the registry defaults", () => {
    vi.stubEnv("VERTEX_MODEL", undefined);
    vi.stubEnv("VERTEX_SOCIAL_MODEL", undefined);
    vi.stubEnv("VERTEX_MODEL_FALLBACKS", undefined);
    expect(copilotConfig.vertexModel).toBe(MODEL_DEFAULTS.research);
    expect(copilotConfig.vertexSocialModel).toBe(MODEL_DEFAULTS.social);
    expect(copilotConfig.vertexModelFallbacks).toEqual([...MODEL_DEFAULTS.fallback]);
  });
  it("switches models by env alone, and never lists the primary as its own fallback", () => {
    vi.stubEnv("VERTEX_MODEL", "gemini-3.5-flash");
    vi.stubEnv("VERTEX_MODEL_FALLBACKS", "gemini-3.5-flash,gemini-3.8-flash");
    expect(copilotConfig.vertexModel).toBe("gemini-3.5-flash");
    expect(copilotConfig.vertexModelFallbacks).toEqual(["gemini-3.8-flash"]);
  });
});
