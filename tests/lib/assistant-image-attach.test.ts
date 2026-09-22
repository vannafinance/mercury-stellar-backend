import { describe, expect, it } from "vitest";
import {
  attachmentFitsBudget,
  isAllowedImageMime,
  stripDataUrlPrefix,
} from "@/lib/assistant/image-attach";
import { MAX_IMAGE_B64_CHARS } from "@/lib/assistant/packet";

describe("assistant image attach guards", () => {
  it("allows png/jpeg/webp only", () => {
    expect(isAllowedImageMime("image/png")).toBe(true);
    expect(isAllowedImageMime("image/jpeg")).toBe(true);
    expect(isAllowedImageMime("image/webp")).toBe(true);
    expect(isAllowedImageMime("image/gif")).toBe(false);
    expect(isAllowedImageMime("image/svg+xml")).toBe(false);
    expect(isAllowedImageMime("application/pdf")).toBe(false);
    expect(isAllowedImageMime("")).toBe(false);
  });

  it("strips a data URL prefix and rejects raw or empty input", () => {
    expect(stripDataUrlPrefix("data:image/png;base64,aaa")).toEqual({
      mime: "image/png",
      data: "aaa",
    });
    expect(stripDataUrlPrefix("data:image/jpeg;base64,abc\ndef")).toEqual({
      mime: "image/jpeg",
      data: "abcdef",
    });
    expect(stripDataUrlPrefix("data:image/webp;base64,")).toBeNull();
    expect(stripDataUrlPrefix("aaa")).toBeNull();
    expect(stripDataUrlPrefix("")).toBeNull();
  });

  it("rejects empty or oversized base64", () => {
    expect(attachmentFitsBudget("abc")).toBe(true);
    expect(attachmentFitsBudget("")).toBe(false);
    expect(attachmentFitsBudget("a".repeat(MAX_IMAGE_B64_CHARS))).toBe(true);
    expect(attachmentFitsBudget("a".repeat(MAX_IMAGE_B64_CHARS + 1))).toBe(false);
  });
});
