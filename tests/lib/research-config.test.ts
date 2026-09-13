import { afterEach, describe, expect, it, vi } from "vitest";
import { researchConfig } from "@/lib/copilot/research-config";

describe("researchConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a distinct code when the kill switch is on", () => {
    vi.stubEnv("COPILOT_RESEARCH_ENABLED", "false");
    const cfg = researchConfig();
    expect(cfg.ok).toBe(false);
    if (cfg.ok) return;
    expect(cfg.code).toBe("research_disabled");
    expect(cfg.status).toBe(503);
  });
});
