import os
import base64
from pathlib import Path
from playwright.sync_api import sync_playwright

p1 = Path("docs/copilot/runs/fail-prompt-how-much-xlm-withdraw.png")
p2 = Path("docs/copilot/runs/margin-page-positions-discrepancy.png")
p3 = Path("docs/copilot/runs/margin-account-info.png")

with open(p1, "rb") as f:
    img1_b64 = base64.b64encode(f.read()).decode("utf-8")
with open(p2, "rb") as f:
    img2_b64 = base64.b64encode(f.read()).decode("utf-8")
with open(p3, "rb") as f:
    img3_b64 = base64.b64encode(f.read()).decode("utf-8")

DESKTOP_PDF = Path(r"C:/Users/akgam/Desktop/Failed_Prompt_Test_How_Much_XLM_Can_I_Withdraw.pdf")

html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Vanna Copilot - Prompt Test Failure: how much xlm can i withdraw?</title>
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
    line-height: 1.42;
    font-size: 12px;
    margin: 0;
    padding: 0;
  }}
  .header-bar {{
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 2px solid #e2e8f0;
    padding-bottom: 10px;
    margin-bottom: 14px;
  }}
  .logo-title {{
    font-size: 18px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: #0f172a;
  }}
  .logo-subtitle {{
    font-size: 10.5px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    margin-top: 1px;
  }}
  .badge-wrong {{
    background: #fef2f2;
    color: #991b1b;
    border: 1.5px solid #ef4444;
    padding: 4px 10px;
    border-radius: 6px;
    font-weight: 800;
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
    padding: 8px 10px;
    margin-bottom: 14px;
  }}
  .meta-item {{
    display: flex;
    flex-direction: column;
  }}
  .meta-label {{
    font-size: 9px;
    font-weight: 700;
    color: #64748b;
    text-transform: uppercase;
  }}
  .meta-val {{
    font-size: 11px;
    font-weight: 600;
    color: #1e293b;
    font-family: 'JetBrains Mono', Consolas, monospace;
  }}
  .section-title {{
    font-size: 12.5px;
    font-weight: 700;
    color: #0f172a;
    border-bottom: 1px solid #cbd5e1;
    padding-bottom: 3px;
    margin-top: 14px;
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }}
  .prompt-box {{
    background: #f1f5f9;
    border-left: 4px solid #3b82f6;
    border-radius: 0 6px 6px 0;
    padding: 8px 12px;
    margin-bottom: 12px;
  }}
  .prompt-tag {{
    font-size: 9px;
    font-weight: 800;
    color: #2563eb;
    text-transform: uppercase;
    margin-bottom: 2px;
  }}
  .prompt-text {{
    font-size: 13px;
    font-weight: 700;
    color: #0f172a;
    font-family: 'JetBrains Mono', Consolas, monospace;
  }}
  .screenshot-container {{
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    overflow: hidden;
    background: #090d16;
    padding: 5px;
    margin-bottom: 4px;
    text-align: center;
  }}
  .screenshot-img {{
    max-width: 100%;
    height: auto;
    border-radius: 3px;
    display: block;
    margin: 0 auto;
  }}
  .caption {{
    font-size: 10px;
    color: #64748b;
    text-align: center;
    margin-bottom: 10px;
    font-style: italic;
  }}
  .discrepancy-card {{
    background: #fef2f2;
    border: 1.5px solid #f87171;
    border-radius: 8px;
    padding: 10px 14px;
    margin-bottom: 14px;
    page-break-inside: avoid;
  }}
  .discrepancy-title {{
    font-weight: 800;
    color: #991b1b;
    font-size: 12.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 6px;
    display: flex;
    justify-content: space-between;
  }}
  .math-formula {{
    background: #ffffff;
    border: 1px solid #fca5a5;
    border-radius: 6px;
    padding: 8px 12px;
    font-family: 'JetBrains Mono', Consolas, monospace;
    font-size: 12.5px;
    font-weight: 700;
    color: #b91c1c;
    text-align: center;
    margin: 6px 0;
  }}
  table.data-table {{
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 12px;
    font-size: 11px;
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
    font-size: 9.5px;
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
    font-size: 9.5px;
    display: inline-block;
  }}
  .pass-tag {{
    background: #f0fdf4;
    color: #15803d;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid #86efac;
    font-size: 9.5px;
    display: inline-block;
  }}
  .card {{
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 8px 12px;
    margin-bottom: 10px;
    page-break-inside: avoid;
  }}
  .card-title {{
    font-weight: 700;
    font-size: 11.5px;
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
    font-size: 10.5px;
    color: #0f172a;
  }}
  ul {{
    margin: 4px 0 6px 16px;
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
    <div class="logo-subtitle">Automated Prompt Battery Verification & Ground Truth Audit</div>
  </div>
  <div>
    <span class="badge-wrong">RESULT: WRONG · CONFIDENT COLLATERAL HALLUCINATION</span>
  </div>
</div>

<div class="meta-grid">
  <div class="meta-item">
    <span class="meta-label">Incident Ref</span>
    <span class="meta-val">BATTERY-FAIL-W03</span>
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
    <span class="meta-label">Ground Truth Venue</span>
    <span class="meta-val">Vanna /margin Surface Table</span>
  </div>
</div>

<div class="section-title">1. Prompt Under Test (Verbatim Input)</div>
<div class="prompt-box">
  <div class="prompt-tag">User Submission via /copilot Surface</div>
  <div class="prompt-text">how much xlm can i withdraw?</div>
</div>

<div class="section-title">2. Copilot Response (Verbatim UI Screenshot)</div>
<div class="screenshot-container">
  <img class="screenshot-img" src="data:image/png;base64,{img1_b64}" alt="Copilot Response Screenshot" />
</div>
<div class="caption">Figure 3.1: Copilot response claiming that posted XLM collateral is '~139.39 XLM ($25.03 USD)' and that 'the full posted XLM collateral balance of ~139.39 XLM is available for withdrawal'.</div>

<div class="section-title">3. Margin Page Ground Truth (Screenshots Directly Below)</div>
<div class="screenshot-container">
  <img class="screenshot-img" src="data:image/png;base64,{img2_b64}" alt="Margin Page Positions Table" />
</div>
<div class="caption">Figure 3.2: Vanna Margin page live positions table showing actual Collateral Deposited XLM: <strong>70.91 XLM ($12.73)</strong> and Borrowed Assets XLM: <strong>68.48 XLM ($12.30)</strong>.</div>

<div style="display: grid; grid-template-columns: 1fr; gap: 4px; margin-top: 6px;">
  <div class="screenshot-container" style="max-width: 75%; margin: 0 auto;">
    <img class="screenshot-img" src="data:image/png;base64,{img3_b64}" alt="Margin Account Info" />
  </div>
</div>
<div class="caption">Figure 3.3: Vanna Margin Account Info header showing Total Borrowed value $210.55, Net Available Collateral $4.28K, and Net Health Factor 21.34.</div>

<div class="page-break"></div>

<div class="section-title">4. Mathematical Proof of Defect: Debt Conflated as Collateral</div>

<div class="discrepancy-card">
  <div class="discrepancy-title">
    <span>Empirical Discrepancy Breakdown</span>
    <span class="fail-tag">CRITICAL MATH DEFECT</span>
  </div>
  <p>On the live <code>/margin</code> page, the trader's actual position is explicitly segregated into posted collateral and borrowed liability:</p>
  <ul>
    <li><strong>Actual Posted XLM Collateral (Deposited):</strong> <code>70.91 XLM ($12.73 USD)</code></li>
    <li><strong>Actual Borrowed XLM Liability (Debt):</strong> <code>68.48 XLM ($12.30 USD)</code></li>
  </ul>
  <p style="margin-top: 6px;">The Copilot stated:</p>
  <blockquote style="margin: 4px 0; padding-left: 10px; border-left: 3px solid #ef4444; color: #7f1d1d; font-style: italic;">
    "Posted XLM collateral in the margin account is ~139.39 XLM ($25.03 USD)... the full posted XLM collateral balance of ~139.39 XLM is available for withdrawal..."
  </blockquote>
  <div class="math-formula">
    70.91 XLM (Collateral) + 68.48 XLM (Debt) = 139.39 XLM ($25.03 USD)
  </div>
  <p style="font-size: 11.5px; color: #991b1b; margin-top: 4px;">
    <strong>The Defect:</strong> The copilot calculated total account tokens by summing the user's collateral <em>plus</em> their debt, and falsely presented this sum as the posted collateral balance available for withdrawal!
  </p>
</div>

<div class="section-title">5. Ground Truth vs Copilot Response Telemetry</div>
<table class="data-table">
  <thead>
    <tr>
      <th style="width: 25%;">Metric / Position Item</th>
      <th style="width: 35%;">Margin Page Ground Truth</th>
      <th style="width: 40%;">Copilot Stated Response</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Posted XLM Collateral</strong></td>
      <td><strong>70.91 XLM</strong> ($12.73 USD)</td>
      <td><span class="fail-tag">WRONG</span> <strong>~139.39 XLM</strong> ($25.03 USD) [+$12.30 false collateral]</td>
    </tr>
    <tr>
      <td><strong>Withdrawable XLM</strong></td>
      <td>Maximum <strong>70.91 XLM</strong> (contract balance ceiling)</td>
      <td><span class="fail-tag">REVERT RISK</span> <strong>~139.39 XLM</strong> (attempting to withdraw reverts)</td>
    </tr>
    <tr>
      <td><strong>Borrowed XLM Debt</strong></td>
      <td><strong>68.48 XLM</strong> ($12.30 USD)</td>
      <td><span class="pass-tag">ACCURATE</span> Correctly read 68.48 XLM debt</td>
    </tr>
    <tr>
      <td><strong>Total Debt USD</strong></td>
      <td><strong>$210.55 USD</strong></td>
      <td><span class="pass-tag">ACCURATE</span> Correctly read $210.55 USD total debt</td>
    </tr>
    <tr>
      <td><strong>Net Health Factor</strong></td>
      <td><strong>21.34</strong> (High Safety Buffer)</td>
      <td>Stated LTV 4.83% and liquidation threshold 90.9%</td>
    </tr>
  </tbody>
</table>

<div class="section-title">6. DeFi Protocol Invariants & Contract Implications</div>

<div class="alert-warning">
  <strong>Protocol Invariant Law:</strong>
  Under Vanna Soroban Protocol V1 (<code>AccountManager</code>), <code>withdraw_collateral_balance</code> burns or unbinds posted collateral tokens. A user can NEVER withdraw more collateral than is actually posted on chain, regardless of health factor.
</div>

<ul>
  <li><strong>On-Chain Revert:</strong> If a user executes the copilot's recommendation and requests withdrawal of 139.39 XLM, the transaction will fail on chain because <code>AccountManager</code> only holds 70.91 XLM in posted collateral.</li>
  <li><strong>Confident Wrong Answer Priority:</strong> In financial engineering, a confident wrong answer is classified as severity level 1 (outranking all UI and timing issues). Hallucinating collateral creates false liquidity expectations.</li>
  <li><strong>Debt Conflation Risk:</strong> Borrowed assets are liabilities owed back to the lending pool; summing liability with asset collateral inverts the basic accounting equation.</li>
</ul>

<div class="page-break"></div>

<div class="section-title">7. Architectural Root Cause & Code Trace</div>

<div class="card">
  <div class="card-title">
    <span>Root Cause in MCP Read & Normalization Layer</span>
    <span class="fail-tag">AGGREGATION LEAK</span>
  </div>
  <p>The copilot queried margin account status via the hosted MCP tool. The failure occurred in one of two places:</p>
  <ul>
    <li><strong>Raw Contract Token Balance vs Posted Balance:</strong> The read tool queried the SAC (Soroban Asset Contract) balance of XLM held by the smart account address (which holds both posted collateral tokens and recently borrowed/unrouted tokens), rather than querying the <code>AccountManager.get_collateral(account, XLM)</code> storage entry.</li>
    <li><strong>LLM Hallucinatory Aggregation:</strong> During research synthesis in <code>lib/copilot/investigation/flash.ts</code>, the language model read the debt item (68.48 XLM) and collateral item (70.91 XLM) and erroneously summed them: $70.91 + 68.48 = 139.39$, attributing the entire sum to "Posted XLM collateral".</li>
  </ul>
</div>

<div class="section-title">8. Concrete Institutional Remediation Specification</div>

<div class="card">
  <div class="card-title">Immediate Engineering Action Items</div>
  <ul>
    <li><strong>Strict Separation of Collateral and Debt:</strong> In <code>lib/copilot/investigation/facts-by-shape.ts</code> and <code>normalize.ts</code>, assert that <code>posted_collateral</code> is sourced strictly from <code>vanna_margin_status · collateral</code>. Debt quantities from <code>vanna_margin_status · debt</code> must never enter collateral math.</li>
    <li><strong>Withdrawable Balance Ceiling Formula:</strong> Enforce the deterministic formula for withdrawable asset balance:
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 6px 10px; margin: 6px 0; font-family: monospace; font-size: 11.5px;">
        withdrawable = min(posted_collateral, max_withdrawable_at_hf_floor)
      </div>
      Even with an astronomical Health Factor (21.34), <code>withdrawable</code> can NEVER exceed <code>posted_collateral</code> (70.91 XLM).
    </li>
    <li><strong>Reconciliation Test Suite:</strong> Add automated regression tests comparing <code>copilot/handle-read</code> output against live Margin page REST/RPC endpoints to ensure absolute 1:1 parity between the UI tables and copilot claims.</li>
  </ul>
</div>

<div style="margin-top: 24px; padding-top: 8px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8;">
  <span>Vanna Copilot Quality Assurance & Verification Suite</span>
  <span>Document Generated: September 13, 2026</span>
</div>

</body>
</html>
"""

temp_html = Path("temp_report_3.html")
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
