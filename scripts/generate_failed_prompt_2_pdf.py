import os
import base64
from pathlib import Path
from playwright.sync_api import sync_playwright

IMAGE_PATH = Path("docs/copilot/runs/fail-prompt-withdraw-5k-xlm.png")
if not IMAGE_PATH.exists():
    IMAGE_PATH = Path(r"C:/Users/akgam/.gemini/antigravity/brain/db8be269-b2f8-43dd-a1f6-79c830752811/.user_uploaded/media_1789320828978.png")

with open(IMAGE_PATH, "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode("utf-8")

DESKTOP_PDF = Path(r"C:/Users/akgam/Desktop/Failed_Prompt_Test_Withdraw_5k_XLM.pdf")

html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Vanna Copilot - Prompt Test Failure Report: withdraw 5k xlm</title>
<style>
  @page {{
    size: A4;
    margin: 12mm 14mm 12mm 14mm;
  }}
  * {{
    box-sizing: border-box;
  }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #0f172a;
    background-color: #ffffff;
    line-height: 1.45;
    font-size: 12.5px;
    margin: 0;
    padding: 0;
  }}
  .header-bar {{
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 2px solid #e2e8f0;
    padding-bottom: 12px;
    margin-bottom: 16px;
  }}
  .logo-title {{
    font-size: 19px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: #0f172a;
  }}
  .logo-subtitle {{
    font-size: 11px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    margin-top: 2px;
  }}
  .badge-failed {{
    background: #fef2f2;
    color: #b91c1c;
    border: 1px solid #f87171;
    padding: 4px 10px;
    border-radius: 6px;
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }}
  .meta-grid {{
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 10px 12px;
    margin-bottom: 16px;
  }}
  .meta-item {{
    display: flex;
    flex-direction: column;
  }}
  .meta-label {{
    font-size: 9.5px;
    font-weight: 700;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }}
  .meta-val {{
    font-size: 11.5px;
    font-weight: 600;
    color: #1e293b;
    font-family: 'JetBrains Mono', Consolas, monospace;
    margin-top: 1px;
  }}
  .section-title {{
    font-size: 13px;
    font-weight: 700;
    color: #0f172a;
    border-bottom: 1px solid #cbd5e1;
    padding-bottom: 4px;
    margin-top: 16px;
    margin-bottom: 10px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }}
  .prompt-box {{
    background: #f1f5f9;
    border-left: 4px solid #3b82f6;
    border-radius: 0 6px 6px 0;
    padding: 10px 14px;
    margin-bottom: 14px;
  }}
  .prompt-tag {{
    font-size: 9.5px;
    font-weight: 800;
    color: #2563eb;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 3px;
  }}
  .prompt-text {{
    font-size: 13.5px;
    font-weight: 700;
    color: #0f172a;
    font-family: 'JetBrains Mono', Consolas, monospace;
  }}
  .screenshot-container {{
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    overflow: hidden;
    background: #090d16;
    padding: 6px;
    margin-bottom: 6px;
    text-align: center;
  }}
  .screenshot-img {{
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    display: block;
    margin: 0 auto;
  }}
  .caption {{
    font-size: 10.5px;
    color: #64748b;
    text-align: center;
    margin-bottom: 14px;
    font-style: italic;
  }}
  table.data-table {{
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 14px;
    font-size: 11.5px;
    page-break-inside: avoid;
  }}
  table.data-table th {{
    background: #f1f5f9;
    color: #475569;
    text-align: left;
    padding: 6px 8px;
    font-weight: 700;
    border-bottom: 1px solid #cbd5e1;
    border-top: 1px solid #e2e8f0;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.03em;
  }}
  table.data-table td {{
    padding: 6px 8px;
    border-bottom: 1px solid #e2e8f0;
    vertical-align: top;
  }}
  .fail-tag {{
    background: #fef2f2;
    color: #b91c1c;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid #fca5a5;
    font-size: 10px;
    display: inline-block;
  }}
  .pass-tag {{
    background: #f0fdf4;
    color: #15803d;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid #86efac;
    font-size: 10px;
    display: inline-block;
  }}
  .card {{
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 10px 12px;
    margin-bottom: 10px;
    page-break-inside: avoid;
  }}
  .card-title {{
    font-weight: 700;
    font-size: 12px;
    color: #1e293b;
    margin-bottom: 4px;
    display: flex;
    justify-content: space-between;
  }}
  .alert-warning {{
    background: #fffbeb;
    border: 1px solid #fcd34d;
    border-left: 4px solid #f59e0b;
    border-radius: 0 6px 6px 0;
    padding: 8px 10px;
    margin-bottom: 12px;
    font-size: 11px;
    page-break-inside: avoid;
  }}
  .page-break {{
    page-break-before: always;
  }}
  code {{
    background: #f1f5f9;
    padding: 1px 3px;
    border-radius: 3px;
    font-family: 'JetBrains Mono', Consolas, monospace;
    font-size: 11px;
    color: #0f172a;
  }}
  ul {{
    margin: 4px 0 8px 16px;
    padding: 0;
  }}
  li {{
    margin-bottom: 3px;
  }}
</style>
</head>
<body>

<div class="header-bar">
  <div>
    <div class="logo-title">VANNA COPILOT ORCHESTRATOR</div>
    <div class="logo-subtitle">Automated Prompt Battery Verification & Incident Report</div>
  </div>
  <div>
    <span class="badge-failed">TEST FAILED · PARTIAL / REFUSED-WRONGLY</span>
  </div>
</div>

<div class="meta-grid">
  <div class="meta-item">
    <span class="meta-label">Incident Ref</span>
    <span class="meta-val">BATTERY-FAIL-W02</span>
  </div>
  <div class="meta-item">
    <span class="meta-label">Environment</span>
    <span class="meta-val">Testnet / Privy Signed-in</span>
  </div>
  <div class="meta-item">
    <span class="meta-label">Branch & Commit</span>
    <span class="meta-val">copilot-upgrade @ 4448475</span>
  </div>
  <div class="meta-item">
    <span class="meta-label">Execution Latency</span>
    <span class="meta-val">Checked 12s (Device 22s)</span>
  </div>
</div>

<div class="section-title">1. Prompt Under Test (Verbatim Input)</div>
<div class="prompt-box">
  <div class="prompt-tag">User Submission via /copilot Intent Surface</div>
  <div class="prompt-text">withdraw 5k xlm</div>
</div>

<div class="section-title">2. Empirical Runtime Screenshot (Live Verification)</div>
<div class="screenshot-container">
  <img class="screenshot-img" src="data:image/png;base64,{img_b64}" alt="Copilot UI State Screenshot" />
</div>
<div class="caption">Figure 2.0: Verbatim screenshot captured on /copilot interface illustrating literal action understanding ('Withdraw 5,000 XLM from margin collateral') followed by silent compilation failure, zero execution proposal steps, and terminal 'Start over' button.</div>

<div class="section-title">3. Verbatim UI Telemetry & Element Audit</div>
<table class="data-table">
  <thead>
    <tr>
      <th style="width: 24%;">UI Element</th>
      <th style="width: 46%;">Rendered Value (Verbatim)</th>
      <th style="width: 30%;">Audit Verdict</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Stated Finding</strong></td>
      <td><code>"User requested withdrawal of 5,000 XLM collateral from margin account."</code></td>
      <td><span class="pass-tag">ACCURATE</span> Correctly identified 5,000 XLM withdrawal intent</td>
    </tr>
    <tr>
      <td><strong>Notice Header</strong></td>
      <td><code>"This thread is kept in this browser tab..."</code></td>
      <td><span class="pass-tag">NOMINAL</span> Standard browser session lifecycle warning</td>
    </tr>
    <tr>
      <td><strong>Card Headline</strong></td>
      <td><code>"Withdraw 5,000 XLM from margin collateral."</code></td>
      <td><span class="pass-tag">CORRECT GOAL</span> Accurately stated user's financial goal</td>
    </tr>
    <tr>
      <td><strong>Latency Banner</strong></td>
      <td><code>"Checked in 12s · 22s this device"</code></td>
      <td><span class="pass-tag">REAL VALUES</span> Fast turn 1 research (12s investigation, 22s device)</td>
    </tr>
    <tr>
      <td><strong>Action Proposal</strong></td>
      <td><code>[Start over]</code> (Zero execution buttons, no proposal card)</td>
      <td><span class="fail-tag">SILENT DROP</span> Action compiled to 0 steps; terminal deadlock</td>
    </tr>
  </tbody>
</table>

<div class="page-break"></div>

<div class="section-title">4. Deep Technical Root Cause: The "5k" Unit Anchoring Bug</div>

<div class="card">
  <div class="card-title">
    <span>Mechanistic Root Cause: String Substring Anchoring in quantities.ts</span>
    <span class="fail-tag">COMPILER DEFECT</span>
  </div>
  <p>The copilot's language model (Gemini Flash) performed its task correctly: it parsed the user's abbreviation <code>"5k xlm"</code> and produced:</p>
  <code>{{ op: "withdraw_collateral", asset: "XLM", amount: "5000", sourceQuote: "5k xlm" }}</code>
  <p style="margin-top: 6px;">However, deterministic verification in <code>lib/copilot/investigation/requested-actions.ts</code> executed:</p>
  <code>isTokenAmountIn(action.sourceQuote, action.amount)</code>
  <p style="margin-top: 6px;">Inside <code>lib/copilot/investigation/quantities.ts</code> line 50:</p>
  <code>if (!amount || !text.includes(amount)) return false;</code>
  <p style="margin-top: 6px;">Because <code>"5k xlm".includes("5000")</code> is <strong>false</strong>, <code>isTokenAmountIn</code> returned <code>false</code>! This triggered <code>throw new Error("unanchored_amount")</code>.</p>
</div>

<div class="card">
  <div class="card-title">
    <span>Silent Exception Suppression in compileRequestedActions</span>
    <span class="fail-tag">SILENT FAILURE</span>
  </div>
  <p>In <code>lib/copilot/investigation/requested-actions.ts</code> lines 54-56:</p>
  <code>try {{ ... }} catch {{ return []; }}</code>
  <p style="margin-top: 6px;">The <code>unanchored_amount</code> exception was silently caught. <code>compileRequestedActions</code> returned an empty array <code>[]</code>. The system did not warn the user, did not explain that "5k" failed parsing, and did not prompt for clarification.</p>
</div>

<div class="card">
  <div class="card-title">
    <span>Fallback Deadlock in service.ts</span>
    <span class="fail-tag">DEAD-END UX</span>
  </div>
  <p>In <code>service.ts</code>, <code>earlySteps</code> was empty (because of the compiler drop), and <code>candidates</code> was null (no auto-generated fixed strategy exists for a standalone collateral withdrawal). Consequently, the orchestrator returned findings and an objective title with <strong>zero proposed actions</strong>, trapping the user at a dead-end <code>[Start over]</code> button.</p>
</div>

<div class="section-title">5. Protocol Invariants & Bypassed Financial Safety Checks</div>

<div class="alert-warning">
  <strong>Safety Law Audit:</strong>
  Under Vanna Soroban Protocol V1, <code>withdraw_collateral</code> is a health-lowering operation. Protocol law requires $HF > 1.10$ (<code>LIQUIDATION_THRESHOLD_WAD</code>) after execution. Furthermore, on this test account (<code>CCKIT…DMC</code>), the Margin page and the liquidation engine disagree on collateral (~883 XLM unposted).
</div>

<p>Because the unit parser dropped the step at compile time, the copilot <strong>never even reached the financial preflight checks</strong>! Specifically:</p>
<ul>
  <li>It never queried <code>vanna_margin_read · can_withdraw</code> with 5,000 XLM.</li>
  <li>It never evaluated whether removing 5,000 XLM would breach $HF > 1.10$.</li>
  <li>It never checked whether the account collateral figures disagreed, failing to emit the mandatory disagreement refusal.</li>
</ul>

<div class="page-break"></div>

<div class="section-title">6. Architectural Comparison: Intended vs Observed Flow</div>

<table class="data-table">
  <thead>
    <tr>
      <th style="width: 20%;">Stage</th>
      <th style="width: 40%;">Observed Runtime Failure</th>
      <th style="width: 40%;">Correct Institutional Implementation</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>1. User Input</strong></td>
      <td><code>"withdraw 5k xlm"</code></td>
      <td><code>"withdraw 5k xlm"</code></td>
    </tr>
    <tr>
      <td><strong>2. Model Handoff</strong></td>
      <td>Emitted <code>amount: "5000"</code>, <code>sourceQuote: "5k xlm"</code></td>
      <td>Emitted <code>amount: "5000"</code>, <code>sourceQuote: "5k xlm"</code></td>
    </tr>
    <tr>
      <td><strong>3. Token Anchoring</strong></td>
      <td><code>"5k xlm".includes("5000") == false</code> &rarr; <strong>Exception thrown</strong></td>
      <td>Parse metric suffixes: <code>5k == 5000</code> &rarr; <strong>Anchored successfully</strong></td>
    </tr>
    <tr>
      <td><strong>4. Step Compilation</strong></td>
      <td>Silently caught to <code>[]</code> steps &rarr; <strong>Zero proposals</strong></td>
      <td>Compiles <code>withdraw_collateral 5000 XLM</code> proposal step</td>
    </tr>
    <tr>
      <td><strong>5. Preflight / Safety</strong></td>
      <td>Never executed; completely bypassed</td>
      <td>Evaluates $HF > 1.10$; if permitted: show proposal; if collateral figures disagree: show transparent refusal</td>
    </tr>
  </tbody>
</table>

<div class="section-title">7. Concrete Remediation Plan</div>
<div class="card">
  <div class="card-title">Production Code Changes Required</div>
  <ul>
    <li><strong>Metric Suffix Support in quantities.ts:</strong> Enhance <code>quantitySpans</code> and <code>isTokenAmountIn</code> to recognize metric multipliers (<code>k</code> / <code>K</code> = $\times 10^3$, <code>m</code> / <code>M</code> = $\times 10^6$, <code>b</code> / <code>B</code> = $\times 10^9$). When comparing <code>amount</code> to <code>sourceQuote</code>, compare numerical equivalency after multiplier expansion rather than raw string inclusion.</li>
    <li><strong>Transparent Parsing Errors:</strong> If an action fails anchoring in <code>compileRequestedActions</code>, do not silently swallow it. Log the specific reason (e.g. <code>unanchored_amount</code>) and surface a helpful card notice: <em>"Did you mean 5,000 XLM? Please confirm the amount."</em></li>
    <li><strong>Prevent Blank Proposal Cards:</strong> When the user's intent is clearly an action (e.g. <code>withdraw</code>), the UI must never render an empty card with only <code>[Start over]</code>. It must either propose the action, explain the refusal, or ask for the missing parameter.</li>
  </ul>
</div>

<div style="margin-top: 24px; padding-top: 8px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 10.5px; color: #94a3b8;">
  <span>Vanna Copilot Quality Assurance & Verification Suite</span>
  <span>Document Generated: September 13, 2026</span>
</div>

</body>
</html>
"""

temp_html = Path("temp_report_2.html")
temp_html.write_text(html_content, encoding="utf-8")

p = sync_playwright().start()
browser = p.chromium.launch()
page = browser.new_page()
page.set_content(html_content, wait_until="networkidle")
page.pdf(
    path=str(DESKTOP_PDF),
    format="A4",
    print_background=True,
    margin={"top": "10mm", "bottom": "10mm", "left": "10mm", "right": "10mm"},
)
browser.close()
p.stop()
if temp_html.exists():
    temp_html.unlink()

print("PDF successfully generated at:", DESKTOP_PDF)
print("File size (bytes):", DESKTOP_PDF.stat().st_size)
