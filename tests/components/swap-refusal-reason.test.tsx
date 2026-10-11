// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SwapIntentPreviewCard } from "@/components/copilot/swap-review-card";

afterEach(cleanup);
describe("swap refusal guidance", () => {
  it("does not suggest accepting loss to bypass an insufficient balance", () => {
    render(<SwapIntentPreviewCard wallet={null} intent={{ tokenIn: "XLM", tokenOut: "AQUSDC", venue: "aquarius", amount: "1000000", amountAsset: "asset" }} refusal="Only 100 XLM is in the margin account." />);
    expect(screen.getByText(/Only 100 XLM/).textContent).not.toContain("accept the quoted loss");
  });
  it("preserves loss guidance when it is part of the actual risk reason", () => {
    render(<SwapIntentPreviewCard wallet={null} intent={{ tokenIn: "XLM", tokenOut: "AQUSDC", venue: "aquarius", amount: "100", amountAsset: "asset" }} refusal="The quote has a loss. State that you accept the quoted loss to proceed." />);
    expect(screen.getByText(/The quote has a loss/).textContent?.match(/accept the quoted loss/g)).toHaveLength(1);
  });
});
