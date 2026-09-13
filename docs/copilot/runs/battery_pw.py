"""Drive signed-in /copilot via Playwright CDP. Do not import from app code."""
from __future__ import annotations

import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).with_name("battery-live.json")
SHOT = Path(__file__).with_name("battery-live.png")


def connect():
    p = sync_playwright().start()
    browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    ctx = browser.contexts[0]
    page = next((pg for pg in ctx.pages if "/copilot" in (pg.url or "")), None)
    if page is None:
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
    return p, browser, page


def body(page) -> str:
    return page.inner_text("body")


def start_over(page) -> None:
    if "/copilot" not in (page.url or ""):
        page.goto("http://localhost:3000/copilot", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(2500)
    btn = page.get_by_role("button", name="Start over")
    if btn.count():
        btn.first.click()
        page.wait_for_timeout(1500)


def submit(page, prompt: str) -> None:
    page.wait_for_selector('textarea[aria-label="Copilot intent"]', timeout=20_000)
    page.evaluate(
        """(prompt) => {
          const el = document.querySelector('textarea[aria-label="Copilot intent"]');
          const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
          set.call(el, prompt);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          if (!el.form) throw new Error("no form");
          el.form.requestSubmit();
        }""",
        prompt,
    )


def wait_done(page, prior: str, timeout_s: float = 130) -> str:
    start = time.time()
    last = body(page)
    while time.time() - start < timeout_s:
        text = body(page)
        last = text
        spinning = (
            "Preparing your session" in text
            or "working…" in text.lower()
            or "working..." in text.lower()
        )
        grew = len(text) > len(prior) + 40
        checked = text.count("Checked in") > prior.count("Checked in")
        if grew and checked and not spinning:
            return text
        time.sleep(1.5)
    return last


def run_prompt(page, prompt: str) -> dict:
    prior = body(page)
    t0 = time.time()
    submit(page, prompt)
    text = wait_done(page, prior)
    ms = int((time.time() - t0) * 1000)
    page.screenshot(path=str(SHOT))
    return {"prompt": prompt, "ms": ms, "body": text, "url": page.url}


def main() -> None:
    import sys

    action = sys.argv[1] if len(sys.argv) > 1 else "prompt"
    p, browser, page = connect()
    try:
        if action == "reset":
            start_over(page)
            print(json.dumps({"ok": True, "url": page.url, "has_ta": bool(page.query_selector('textarea[aria-label="Copilot intent"]'))}))
            return
        if action == "prompt":
            prompt = sys.argv[2]
            result = run_prompt(page, prompt)
            existing = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else []
            existing.append({"prompt": result["prompt"], "ms": result["ms"], "url": result["url"], "body_tail": result["body"][-4000:]})
            OUT.write_text(json.dumps(existing, indent=2), encoding="utf-8")
            print(json.dumps({"ms": result["ms"], "url": result["url"], "tail": result["body"][-2500:]}, ensure_ascii=False))
            return
        raise SystemExit(f"unknown action {action}")
    finally:
        p.stop()


if __name__ == "__main__":
    main()
