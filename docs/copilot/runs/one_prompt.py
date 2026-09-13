"""Submit one copilot prompt; do not Approve."""
from __future__ import annotations
import json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

PROMPT = sys.argv[1] if len(sys.argv) > 1 else "put 10 xlm in and lever 3x into sousdc"
OUT = Path(__file__).with_name("last-ui.json")
SHOT = Path(__file__).with_name("battery-live.png")

p = sync_playwright().start()
b = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
page = next(pg for pg in b.contexts[0].pages if "/copilot" in (pg.url or ""))
page.bring_to_front()
if "/copilot" not in (page.url or ""):
    page.goto("http://localhost:3000/copilot", wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_timeout(2500)

btn = page.get_by_role("button", name="Start over")
if btn.count():
    btn.first.click()
    page.wait_for_timeout(1200)

page.wait_for_selector('textarea[aria-label="Copilot intent"]', timeout=25_000)
page.evaluate(
    """(prompt) => {
      const el = document.querySelector('textarea[aria-label="Copilot intent"]');
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      set.call(el, prompt);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.form.requestSubmit();
    }""",
    PROMPT,
)
t0 = time.time()
last = ""
while time.time() - t0 < 90:
    last = page.inner_text("body")
    spinning = "Preparing your session" in last or "Working out what to check" in last
    cut = last.split("SESSION LOG")[0]
    if not spinning and any(x in cut for x in ("Checked in", "Approve and run", "PLAN FOR APPROVAL", "Start over")):
        if PROMPT[:10].lower() in cut.lower() or "Approve" in cut:
            break
    time.sleep(1.2)
ms = int((time.time() - t0) * 1000)
cut = last.split("SESSION LOG")[0]
snip = " ".join(cut.split())[-900:]
row = {
    "prompt": PROMPT,
    "ms": ms,
    "gd4": "GD4BQR" in last,
    "approve": "Approve and run" in last,
    "plan": "PLAN FOR APPROVAL" in last,
    "spinning": "Preparing your session" in last or "Working out" in last,
    "snippet": snip,
}
OUT.write_text(json.dumps(row, indent=2), encoding="utf-8")
page.screenshot(path=str(SHOT))
print(json.dumps(row, ensure_ascii=False)[:2000])
p.stop()
