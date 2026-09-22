import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateSocialLaneJson: vi.fn(),
}));

vi.mock("@/lib/copilot/vertex", () => ({
  generateSocialLaneJson: mocks.generateSocialLaneJson,
}));

import {
  SOCIAL_LANE_TIMEOUT_MS,
  classifySocialLane,
} from "@/lib/copilot/investigation/social-lane";

beforeEach(() => {
  mocks.generateSocialLaneJson.mockReset();
});

afterEach(() => {
  mocks.generateSocialLaneJson.mockReset();
});

describe("social leftover classify", () => {
  it("returns a social reply when Flash-Lite labels the leftover social", async () => {
    mocks.generateSocialLaneJson.mockResolvedValue({
      lane: "social",
      reply: "Hi — I’m Vanna Copilot.",
    });
    await expect(classifySocialLane("hi")).resolves.toEqual({
      lane: "social",
      reply: "Hi — I’m Vanna Copilot.",
    });
    expect(mocks.generateSocialLaneJson.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
  });

  it("drops a social label that came with no reply so investigation is not skipped on empty copy", async () => {
    mocks.generateSocialLaneJson.mockResolvedValue({ lane: "social", reply: "  " });
    await expect(classifySocialLane("hi")).resolves.toBeNull();
  });

  it("fails closed to null on timeout or Vertex error", async () => {
    mocks.generateSocialLaneJson.mockRejectedValue(new Error("aborted"));
    await expect(classifySocialLane("hi")).resolves.toBeNull();
  });

  it("bounds the leftover call", () => {
    expect(SOCIAL_LANE_TIMEOUT_MS).toBe(2_000);
  });
});
