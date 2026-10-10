// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { AnalyticsPrefetcher } from "@/components/analytics-prefetcher";

const state = vi.hoisted(() => ({ pathname: "/copilot", read: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("@/store/user", () => ({ useUserStore: (select: (s: { address: string }) => unknown) => select({ address: "G_TEST" }) }));
vi.mock("@/hooks/use-analytics", () => ({ useAnalyticsSnapshot: state.read }));

describe("Analytics background preload route isolation", () => {
  beforeEach(() => state.read.mockClear());

  it("does not mount the unrelated analytics reader on Copilot", () => {
    state.pathname = "/copilot";
    render(<AnalyticsPrefetcher />);
    expect(state.read).not.toHaveBeenCalled();
  });

  it("preserves preload on other pages and resumes it when leaving Copilot", () => {
    state.pathname = "/copilot";
    const page = render(<AnalyticsPrefetcher />);
    for (const pathname of ["/earn", "/margin", "/farm", "/analytics/overview2"]) {
      state.pathname = pathname;
      page.rerender(<AnalyticsPrefetcher />);
      expect(state.read).toHaveBeenLastCalledWith("G_TEST");
    }
    state.read.mockClear();
    state.pathname = "/copilot";
    page.rerender(<AnalyticsPrefetcher />);
    expect(state.read).not.toHaveBeenCalled();
  });
});
