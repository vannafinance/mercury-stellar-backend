import os
import base64
from pathlib import Path
from playwright.sync_api import sync_playwright

IMAGE_PATH = Path("docs/copilot/runs/fail-prompt-withdraw-xlm.png")
if not IMAGE_PATH.exists():
    IMAGE_PATH = Path(r"C:/Users/akgam/.gemini/antigravity/brain/db8be269-b2f8-43dd-a1f6-79c830752811/.user_uploaded/media_1789320395740.png")

with open(IMAGE_PATH, "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode("utf-8")

DESKTOP_PDF = Path(r"C:/Users/akgam/Desktop/Failed_Prompt_Test_XLM_Withdrawal.pdf")

html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Vanna Copilot - Prompt Test Failure Report</title>
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
    font-size: 12.5px;
    font-weight: 600;
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
    <span class="meta-val">BATTERY-FAIL-W01</span>
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
    <span class="meta-val">Checked 21s (Device 61s)</span>
  </div>
</div>

<div class="section-title">1. Prompt Under Test (Verbatim Input)</div>
<div class="prompt-box">
  <div class="prompt-tag">User Submission via /copilot Intent Surface</div>
  <div class="prompt-text">how much xlm can i withdraw as i dont have an xlm balance in my margin account to deposit so withdraw some so i can deposit it</div>
</div>

<div class="section-title">2. Empirical Runtime Screenshot (Live Verification)</div>
<div class="screenshot-container">
  <img class="screenshot-img" src="data:image/png;base64,{img_b64}" alt="Copilot UI State Screenshot" />
</div>
<div class="caption">Figure 1.0: Verbatim screenshot captured on /copilot interface illustrating leaked planner objective, solitary wallet finding, zero proposal options, and deadlocked 'Start over' state.</div>

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
      <td><strong>Stated Findings</strong></td>
      <td><code>"Your wallet holds 3.8553269 XLM."</code></td>
      <td><span class="fail-tag">DEFICIENT</span> Reads wallet only; ignores Margin & Earn positions</td>
    </tr>
    <tr>
      <td><strong>Notice Header</strong></td>
      <td><code>"This thread is kept in this browser tab..."</code></td>
      <td><span class="pass-tag">NOMINAL</span> Standard browser session lifecycle warning</td>
    </tr>
    <tr>
      <td><strong>Card Headline</strong></td>
      <td><code>"Determine withdrawable XLM amount and clarify existing margin collateral and wallet balances."</code></td>
      <td><span class="fail-tag">LEAKED GOAL</span> Emitted internal orchestrator objective as card title</td>
    </tr>
    <tr>
      <td><strong>Latency Banner</strong></td>
      <td><code>"Checked in 21s · 1m 01s this device"</code></td>
      <td><span class="pass-tag">REAL VALUES</span> Empirical check latency logged accurately</td>
    </tr>
    <tr>
      <td><strong>Action Buttons</strong></td>
      <td><code>[Start over]</code> (Zero execution/plan buttons)</td>
      <td><span class="fail-tag">DEADLOCK</span> No options prepared; user trapped on terminal screen</td>
    </tr>
  </tbody>
</table>

<div class="page-break"></div>

<div class="section-title">4. Core Failure Mode Breakdown</div>

<div class="card">
  <div class="card-title">
    <span>Failure 1: The Core Question Remained Completely Unanswered</span>
    <span class="fail-tag">ZERO NUMERICAL ANSWER</span>
  </div>
  <p>The user explicitly asked: <em>"how much xlm can i withdraw"</em>. The copilot failed to compute or return any withdrawable amount, headroom range, or redeemable balance. It provided neither a numerical figure nor a bounding constraint, completely failing the informational read objective.</p>
</div>

<div class="card">
  <div class="card-title">
    <span>Failure 2: Planner Objective Leakage as Card Title</span>
    <span class="fail-tag">PROMPT / UI LEAK</span>
  </div>
  <p>The string rendered as the headline — <code>"Determine withdrawable XLM amount and clarify existing margin collateral and wallet balances."</code> — is an internal LLM planning objective from <code>outcome.goal.objective</code>. In an institutional system, internal reasoning or task directives must never leak as the primary user-facing response headline.</p>
</div>

<div class="card">
  <div class="card-title">
    <span>Failure 3: Circular Multi-Bucket Contradiction Dropped Without Clarification</span>
    <span class="fail-tag">UNRESOLVED AMBIGUITY</span>
  </div>
  <p>The user prompt presented a circular financial paradox: <em>"as i dont have an xlm balance in my margin account to deposit so withdraw some so i can deposit it"</em>. The user erroneously believed they could withdraw funds from an account that has zero balance in order to deposit back into it. The copilot neither explained this contradiction nor posed an interactive clarifying question (<code>openQuestion</code>).</p>
</div>

<div class="card">
  <div class="card-title">
    <span>Failure 4: Deadlocked Terminal UI State</span>
    <span class="fail-tag">DEAD-END UX</span>
  </div>
  <p>The card prepared 0 candidate plans, offered 0 next actions, and rendered no selectable options. The user was left with a single <code>Start over</code> button, discarding the conversational context and forcing an abortive reset.</p>
</div>

<div class="section-title">5. DeFi Protocol Invariants & Multi-Bucket Liquidity Analysis</div>

<div class="alert-warning">
  <strong>Protocol Invariant Law:</strong>
  Under Vanna Soroban Protocol V1, <code>LIQUIDATION_THRESHOLD_WAD = 1.10</code>. An account is healthy if and only if $HF > 1.10$. Furthermore, user preference safety floors belong exclusively to the user and must never be arbitrarily injected (e.g. defaulting to 1.30 is forbidden).
</div>

<table class="data-table">
  <thead>
    <tr>
      <th style="width: 25%;">Liquidity Bucket</th>
      <th style="width: 35%;">Observed / Protocol State</th>
      <th style="width: 40%;">Binding Constraint & Behavioral Law</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>1. Spendable Wallet</strong><br>(Native Stellar)</td>
      <td>Holds <code>3.8553269 XLM</code> total</td>
      <td><strong>Reserve Locked:</strong> Stellar base reserve (0.5 XLM) + trustline reserves + transaction fee buffer (~0.1 XLM) means actual <em>spendable</em> balance is near zero. Cannot size deposits without funding.</td>
    </tr>
    <tr>
      <td><strong>2. Margin Collateral</strong><br>(Vanna Smart Account)</td>
      <td>Unposted vs posted collateral inside <code>AccountManager</code></td>
      <td><strong>Health Bound:</strong> Withdrawable only if resulting $HF > 1.10$. Funds already in Margin cannot be withdrawn to deposit back into Margin (circular null-op).</td>
    </tr>
    <tr>
      <td><strong>3. Earn Lending Pool</strong><br>(vToken Positions)</td>
      <td>vXLM / vTokens in <code>LendingPool</code></td>
      <td><strong>Redeemable:</strong> vTokens can be redeemed to spendable wallet and then deposited into Margin collateral. Copilot failed to read this bucket.</td>
    </tr>
  </tbody>
</table>

<div class="page-break"></div>

<div class="section-title">6. Architectural Root Cause & Code Path (RCA)</div>
<ul>
  <li><strong>Investigation Loop Gap (<code>lib/copilot/investigation/flash.ts</code>):</strong> The research prompt directed the LLM to inspect balances, but the tool execution only called <code>vanna_wallet · balance</code>. It failed to fan out reads to <code>vanna_margin_read · can_withdraw</code> or <code>vanna_earn_position · balance</code>.</li>
  <li><strong>Decision & Sizing Bypass (<code>lib/copilot/investigation/decision.ts</code>):</strong> Because the prompt was an inquiry ("how much can i withdraw") combined with a conditional desire ("so withdraw some so i can deposit it"), the system classified <code>intent: "strategy"</code> without valid literal actions.</li>
  <li><strong>Candidate Generation Deadlock (<code>lib/copilot/investigation/service.ts</code>):</strong> In <code>service.ts</code>, <code>candidates</code> evaluated to null because no fixed strategy shape matched a withdraw-to-deposit loop. With <code>candidates = null</code> and no compiled <code>question</code>, the system defaulted to returning raw findings with the raw goal objective.</li>
</ul>

<div class="section-title">7. Actionable Institutional Remediation Specification</div>
<div class="card">
  <div class="card-title">Required Production Fix</div>
  <ul>
    <li><strong>Multi-Bucket Balance Fan-Out:</strong> Any inquiry regarding "how much can I withdraw/deposit" must deterministically trigger parallel reads across all three buckets (Wallet spendable, Margin withdrawable via <code>can_withdraw</code>, and Earn redeemable).</li>
    <li><strong>Circular Intent Disentanglement:</strong> Detect when a user requests withdrawing and depositing the same asset across conflicting venues. Clarify immediately: <em>"You hold 3.85 XLM in your wallet (0 spendable after reserves) and $0 XLM in margin collateral. Would you like to redeem XLM from Earn or transfer from another wallet?"</em></li>
    <li><strong>UI Objective Sanitization:</strong> Ensure <code>outcome.goal.objective</code> is never rendered as the card headline when <code>candidates</code> is null; display a synthesized answer or active clarification dialogue instead of a dead-end <code>[Start over]</code> button.</li>
  </ul>
</div>

<div style="margin-top: 20px; padding-top: 8px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 10.5px; color: #94a3b8;">
  <span>Vanna Copilot Quality Assurance & Verification Suite</span>
  <span>Document Generated: September 13, 2026</span>
</div>

</body>
</html>
"""

temp_html = Path("temp_report.html")
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
