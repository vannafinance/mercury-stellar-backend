// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { CopilotShell } from "@/components/copilot/copilot-shell";

describe("CopilotShell — stage auto-scrolling", () => {
  it("renders with cp-stage-scroll container", () => {
    const { container } = render(
      <CopilotShell
        collapsed={false}
        onToggleCollapsed={() => {}}
        empty={false}
        railTop={<div />}
        railBody={<div />}
        railMini={<div />}
        composer={<div>composer</div>}
        thread={<div>thread turn 1</div>}
      />,
    );

    const scroller = container.querySelector(".cp-stage-scroll");
    expect(scroller).toBeTruthy();
  });

  it("scrolls to bottom when justSubmitted is true", async () => {
    vi.useFakeTimers();
    let rAFQueue: Array<() => void> = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rAFQueue.push(cb as () => void);
      return 1;
    });

    const { container, rerender } = render(
      <CopilotShell
        collapsed={false}
        onToggleCollapsed={() => {}}
        empty={false}
        railTop={<div />}
        railBody={<div />}
        railMini={<div />}
        composer={<div>composer</div>}
        thread={<div>thread turn 1</div>}
        justSubmitted={false}
      />,
    );

    const scroller = container.querySelector(".cp-stage-scroll") as HTMLDivElement;
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    scroller.scrollTop = 0;

    // Rerender with justSubmitted: true
    rerender(
      <CopilotShell
        collapsed={false}
        onToggleCollapsed={() => {}}
        empty={false}
        railTop={<div />}
        railBody={<div />}
        railMini={<div />}
        composer={<div>composer</div>}
        thread={<div>thread turn 1<br />new turn 2</div>}
        justSubmitted={true}
        scrollKey="submitted-1"
      />,
    );

    // Flush requestAnimationFrame cycles (double-RAF)
    while (rAFQueue.length > 0) {
      const q = [...rAFQueue];
      rAFQueue = [];
      q.forEach((cb) => cb());
    }

    expect(scroller.scrollTop).toBe(1000);
    vi.restoreAllMocks();
  });
});
