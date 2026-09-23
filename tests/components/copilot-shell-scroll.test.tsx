// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { CopilotShell } from "@/components/copilot/copilot-shell";

/**
 * The chat scrolls with the PAGE (23 Sep, owner: no second scrollbar for the chat), so every
 * assertion here is about `window` scrolling, not an inner box.
 */
const shell = (props: { justSubmitted?: boolean; scrollKey?: string; thread: React.ReactNode }) => (
  <CopilotShell collapsed={false} onToggleCollapsed={() => {}} empty={false}
    railTop={<div />} railBody={<div />} railMini={<div />} composer={<div>composer</div>}
    thread={props.thread} justSubmitted={props.justSubmitted} scrollKey={props.scrollKey} />
);

function frames() {
  let queue: Array<() => void> = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { queue.push(cb as () => void); return 1; });
  return () => { while (queue.length) { const q = [...queue]; queue = []; q.forEach((cb) => cb()); } };
}

afterEach(() => vi.restoreAllMocks());

describe("CopilotShell — the chat scrolls with the page", () => {
  it("has no scroll box of its own", () => {
    const { container } = render(shell({ thread: <div>thread turn 1</div> }));
    const stage = container.querySelector(".cp-stage") as HTMLElement;
    expect(stage).toBeTruthy();
    expect(stage.style.overflowY).toBe("");
  });

  it("shows the end of the page on send when there is no message to pin", () => {
    const flush = frames();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const { rerender } = render(shell({ justSubmitted: false, thread: <div>turn 1</div> }));
    flush();
    scrollTo.mockClear();
    rerender(shell({ justSubmitted: true, scrollKey: "b", thread: <div>turn 1<br />turn 2</div> }));
    flush();
    expect(scrollTo).toHaveBeenCalled();
  });

  /**
   * 23 Sep, owner: on send the view jumped to the bottom and the user's own message scrolled
   * out of sight while a long plan rendered. The new message is pinned to the top of the chat
   * area instead, and later reply updates must not drag the page down.
   */
  it("pins the just-sent message to the top and does not follow the reply down", () => {
    const flush = frames();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const thread = (reply: string) => (
      <div><div>older turn</div><div data-cp-user-bubble=""><p>my new prompt</p></div><div>{reply}</div></div>
    );
    const { container, rerender } = render(shell({ justSubmitted: false, scrollKey: "a", thread: thread("") }));
    flush();
    const bubble = container.querySelector("[data-cp-user-bubble]") as HTMLElement;
    bubble.getBoundingClientRect = () => ({ top: 500, bottom: 540 } as DOMRect);
    scrollTo.mockClear();

    rerender(shell({ justSubmitted: true, scrollKey: "b", thread: thread("working…") }));
    flush();
    // Shell top is 0 in this DOM, so the bubble moves to 12px (the gap) from the top.
    expect(scrollBy).toHaveBeenCalledWith({ top: 488 });

    rerender(shell({ justSubmitted: true, scrollKey: "c", thread: thread("a long plan card") }));
    flush();
    rerender(shell({ justSubmitted: false, scrollKey: "d", thread: thread("a long plan card, settled") }));
    flush();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });

  /**
   * 23 Sep, live: answering the copilot's question ("aquarius lp") never pinned, because the
   * workspace had already recorded the turn and `justSubmitted` never went true. A new bubble
   * in the thread is the send.
   */
  it("pins a new message even when justSubmitted never turns on", async () => {
    const flush = frames();
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const one = <div><div data-cp-user-bubble="">first</div><div>answer</div></div>;
    const two = <div><div data-cp-user-bubble="">first</div><div>answer</div><div data-cp-user-bubble="">aquarius lp</div></div>;
    const { rerender } = render(shell({ scrollKey: "a", thread: one }));
    flush();
    rerender(shell({ scrollKey: "b", thread: two }));
    await Promise.resolve(); // MutationObserver callbacks are microtasks
    flush();
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });
});
