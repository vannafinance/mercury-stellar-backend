"""Signed-in /copilot battery. Does not click Approve."""
from __future__ import annotations

import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).with_name("battery-signed.json")
SHOT = Path(__file__).with_name("battery-live.png")

PROMPTS = [
    "repay 1 xlm",
    "deposit 5 xlm as collateral",
    "deposit me 5xlm and borrow 2x aqusdc and blusdc",
    "put 10 xlm in and lever 3x into sousdc",
    "borrow 50% of my max against xlm",
    "what's my health factor",
    "supply my USDC to the best pool",
    "yeet 1 xlm into earn",
    "unwind 0.5 xlm of debt",
    "lend 1 sousdc",
]


def connect():
    p = sync_playwright().start()
    browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    page = next(pg for pg in browser.contexts[0].pages if "/copilot" in (pg.url or ""))
    page.bring_to_front()
    return p, page


def start_over(page) -> None:
    if "/copilot" not in (page.url or ""):
        page.goto("http://localhost:3000/copilot", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(2000)
    btn = page.get_by_role("button", name="Start over")
    if btn.count():
        btn.first.click()
        page.wait_for_timeout(1200)


def submit(page, prompt: str) -> None:
    page.wait_for_selector('textarea[aria-label="Copilot intent"]', timeout=20_000)
    page.evaluate(
        """(prompt) => {
          const el = document.querySelector('textarea[aria-label="Copilot intent"]');
          const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
          set.call(el, prompt);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.form.requestSubmit();
        }""",
        prompt,
    )


def wait_done(page, prior: str, timeout_s: float = 70) -> str:
    start = time.time()
    last = prior
    while time.time() - start < timeout_s:
        text = page.inner_text("body")
        last = text
        spinning = "Preparing your session" in text
        if spinning:
            time.sleep(1.0)
            continue
        grew = len(text) > len(prior) + 80
        hit = any(
            marker in text
            for marker in (
                "Checked in",
                "Approve and run",
                "PLAN FOR APPROVAL",
                "health factor",
                "ran out of time",
                "didn't respond",
                "didn’t respond",
                "I could not read",
                "I’ve checked",
                "I've checked",
            )
        )
        if grew and hit:
            return text
        time.sleep(1.0)
    return last


def snippet(text: str, prompt: str) -> str:
    # Prefer the live YOU turn, not SESSION LOG history.
    cut = text.split("SESSION LOG")[0]
    low = cut.lower()
    key = prompt.lower()[:28]
    i = low.rfind(key)
    chunk = cut[max(0, i) : max(0, i) + 1100] if i >= 0 else cut[-1200:]
    return " ".join(chunk.split())[:800]


def main() -> None:
    p, page = connect()
    rows = []
    try:
        for prompt in PROMPTS:
            start_over(page)
            prior = page.inner_text("body")
            t0 = time.time()
            submit(page, prompt)
            text = wait_done(page, prior)
            ms = int((time.time() - t0) * 1000)
            row = {
                "prompt": prompt,
                "ms": ms,
                "gd4": "GD4BQR" in text,
                "approve": "Approve and run" in text,
                "timeout": "ran out of time" in text or "didn't respond" in text or "didn’t respond" in text,
                "snippet": snippet(text, prompt),
            }
            rows.append(row)
            print("===", prompt, ms, "ms ===")
            print(row["snippet"][:400])
            OUT.write_text(json.dumps(rows, indent=2), encoding="utf-8")
        page.screenshot(path=str(SHOT))
    finally:
        p.stop()
    print("wrote", OUT, "n=", len(rows))


if __name__ == "__main__":
    main()
