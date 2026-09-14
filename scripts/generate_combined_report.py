import base64
from pathlib import Path
from playwright.sync_api import sync_playwright

p1 = Path("docs/copilot/runs/fail-prompt-withdraw-xlm.png")
p2 = Path("docs/copilot/runs/fail-prompt-withdraw-5k-xlm.png")
p3_copilot = Path("docs/copilot/runs/fail-prompt-how-much-xlm-withdraw.png")
p3_margin = Path("docs/copilot/runs/margin-page-positions-discrepancy.png")
p3_info = Path("docs/copilot/runs/margin-account-info.png")

with open(p1, "rb") as f:
    img1_b64 = base64.b64encode(f.read()).decode("utf-8")
with open(p2, "rb") as f:
    img2_b64 = base64.b64encode(f.read()).decode("utf-8")
with open(p3_copilot, "rb") as f:
    img3_c_b64 = base64.b64encode(f.read()).decode("utf-8")
with open(p3_margin, "rb") as f:
    img3_m_b64 = base64.b64encode(f.read()).decode("utf-8")
with open(p3_info, "rb") as f:
    img3_i_b64 = base64.b64encode(f.read()).decode("utf-8")

out_pdf = Path(r"C:/Users/akgam/Desktop/Failed_Prompt_Tests_Comprehensive_Report.pdf")

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Vanna Copilot - Multi-Incident Failed Prompt Tests Report</title>
<style>
  @page {{ size: A4; margin: 12mm 14mm 12mm 14mm; }}
  * {{ box-sizing: border-box; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a; background: #fff; line-height: 1.42; font-size: 11.5px; margin: 0; }}
  .header-bar {{ display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; margin-bottom: 12px; }}
  .logo-title {{ font-size: 18px; font-weight: 800; color: #0f172a; }}
  .logo-subtitle {{ font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }}
  .badge-failed {{ background: #fef2f2; color: #b91c1c; border: 1.5px solid #ef4444; padding: 3px 8px; border-radius: 5px; font-weight: 800; font-size: 10px; text-transform: uppercase; }}
  .meta-grid {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 10px; margin-bottom: 12px; }}
  .meta-label {{ font-size: 8.5px; font-weight: 700; color: #64748b; text-transform: uppercase; }}
  .meta-val {{ font-size: 10.5px; font-weight: 600; color: #1e293b; font-family: monospace; }}
  .section-title {{ font-size: 12px; font-weight: 700; color: #0f172a; border-bottom: 1px solid #cbd5e1; padding-bottom: 3px; margin-top: 12px; margin-bottom: 8px; text-transform: uppercase; }}
  .prompt-box {{ background: #f1f5f9; border-left: 4px solid #3b82f6; border-radius: 0 6px 6px 0; padding: 6px 10px; margin-bottom: 8px; }}
  .prompt-tag {{ font-size: 8.5px; font-weight: 800; color: #2563eb; text-transform: uppercase; }}
  .prompt-text {{ font-size: 11.5px; font-weight: 700; color: #0f172a; font-family: monospace; }}
  .screenshot-container {{ border: 1px solid #cbd5e1; border-radius: 5px; overflow: hidden; background: #090d16; padding: 4px; margin-bottom: 4px; text-align: center; }}
  .screenshot-img {{ max-width: 100%; height: auto; border-radius: 3px; display: block; margin: 0 auto; }}
  .caption {{ font-size: 9.5px; color: #64748b; text-align: center; margin-bottom: 8px; font-style: italic; }}
  table.data-table {{ width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 10.5px; page-break-inside: avoid; }}
  table.data-table th {{ background: #f1f5f9; color: #475569; text-align: left; padding: 5px 6px; font-weight: 700; border-bottom: 1px solid #cbd5e1; font-size: 9px; text-transform: uppercase; }}
  table.data-table td {{ padding: 5px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }}
  .fail-tag {{ background: #fef2f2; color: #b91c1c; font-weight: 700; padding: 1px 4px; border-radius: 3px; border: 1px solid #fca5a5; font-size: 9px; }}
  .pass-tag {{ background: #f0fdf4; color: #15803d; font-weight: 700; padding: 1px 4px; border-radius: 3px; border: 1px solid #86efac; font-size: 9px; }}
  .card {{ background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; page-break-inside: avoid; }}
  .card-title {{ font-weight: 700; font-size: 11px; color: #1e293b; margin-bottom: 3px; display: flex; justify-content: space-between; }}
  .alert-warning {{ background: #fffbeb; border: 1px solid #fcd34d; border-left: 4px solid #f59e0b; border-radius: 0 6px 6px 0; padding: 6px 8px; margin-bottom: 8px; font-size: 10px; page-break-inside: avoid; }}
  .page-break {{ page-break-before: always; }}
  code {{ background: #f1f5f9; padding: 1px 3px; border-radius: 3px; font-family: monospace; font-size: 10px; }}
  ul {{ margin: 3px 0 6px 14px; padding: 0; }}
  li {{ margin-bottom: 2px; }}
</style>
</head>
<body>

<div class="header-bar">
  <div>
    <div class="logo-title">VANNA COPILOT ORCHESTRATOR</div>
    <div class="logo-subtitle">Automated Prompt Battery Verification & Ground Truth Audit (3 Cases)</div>
  </div>
  <div><span class="badge-failed">SUITE FAILED · 3 INCIDENTS AUDITED</span></div>
</div>

<div class="meta-grid">
  <div><div class="meta-label">Audit Suite ID</div><div class="meta-val">BATTERY-FAIL-SUITE-3X</div></div>
  <div><div class="meta-label">Environment</div><div class="meta-val">Testnet / Privy Signed-in</div></div>
  <div><div class="meta-label">Branch & Commit</div><div class="meta-val">copilot-upgrade @ 4448475</div></div>
  <div><div class="meta-label">Protocol Law</div><div class="meta-val">HF &gt; 1.10 (LIQ_THRESHOLD)</div></div>
</div>

<!-- INCIDENT 1 -->
<div class="section-title">Incident 1: Circular Multi-Bucket Read & Leaked Objective</div>
<div class="prompt-box">
  <div class="prompt-tag">Prompt 1 (Verbatim)</div>
  <div class="prompt-text">how much xlm can i withdraw as i dont have an xlm balance in my margin account to deposit so withdraw some so i can deposit it</div>
</div>
<div class="screenshot-container">
  <img class="screenshot-img" src="data:image/png;base64,{img1_b64}" alt="Incident 1" />
</div>
<div class="caption">Figure 1.0: Copilot outputs wallet finding (3.85 XLM) and internal objective as title; zero options prepared; deadlocks on 'Start over'.</div>

<!-- INCIDENT 2 -->
<div class="section-title" style="margin-top: 14px;">Incident 2: '5k' Multiplier Suffix Dropped by Token Anchor</div>
<div class="prompt-box">
  <div class="prompt-tag">Prompt 2 (Verbatim)</div>
  <div class="prompt-text">withdraw 5k xlm</div>
</div>
<div class="screenshot-container">
  <img class="screenshot-img" src="data:image/png;base64,{img2_b64}" alt="Incident 2" />
</div>
<div class="caption">Figure 2.0: Model parses 5,000 XLM, but quantities.ts substring check fails on '5k'; action is silently discarded to [] steps.</div>

<div class="page-break"></div>

<!-- INCIDENT 3 -->
<div class="section-title">Incident 3: Confident Collateral Hallucination (Debt Conflated as Collateral)</div>
<div class="prompt-box">
  <div class="prompt-tag">Prompt 3 (Verbatim)</div>
  <div class="prompt-text">how much xlm can i withdraw?</div>
</div>

<div class="screenshot-container">
  <img class="screenshot-img" src="data:image/png;base64,{img3_c_b64}" alt="Incident 3 Copilot" />
</div>
<div class="caption">Figure 3.1: Copilot claims posted XLM collateral is <strong>~139.39 XLM ($25.03 USD)</strong> and fully withdrawable.</div>

<div class="section-title" style="margin-top: 10px;">Margin Page Live Ground Truth (Position Comparison)</div>
<div class="screenshot-container">
  <img class="screenshot-img" src="data:image/png;base64,{img3_m_b64}" alt="Incident 3 Margin Table" />
</div>
<div class="caption">Figure 3.2: Actual Margin page table shows <strong>Collateral Deposited: 70.91 XLM ($12.73)</strong> and <strong>Borrowed Assets: 68.48 XLM ($12.30)</strong>.</div>

<div class="screenshot-container" style="max-width: 70%; margin: 0 auto;">
  <img class="screenshot-img" src="data:image/png;base64,{img3_i_b64}" alt="Incident 3 Margin Info" />
</div>
<div class="caption">Figure 3.3: Margin Account Info header confirms Total Borrowed $210.55, Net Collateral $4.28K, Net HF 21.34.</div>

<div class="page-break"></div>

<div class="section-title">Critical Mathematical Defect Proof: Incident 3</div>
<div class="card" style="background: #fef2f2; border: 1.5px solid #f87171;">
  <div class="card-title"><span style="color: #991b1b;">70.91 XLM Collateral + 68.48 XLM Debt = 139.39 XLM ($25.03 USD)</span><span class="fail-tag">CRITICAL WRONG ANSWER</span></div>
  <p>The copilot added the user's posted collateral and their borrowed debt together, reporting the sum as available withdrawable collateral:</p>
  <ul>
    <li><strong>Live Deposited XLM Collateral:</strong> <code>70.91 XLM ($12.73 USD)</code></li>
    <li><strong>Live Borrowed XLM Liability:</strong> <code>68.48 XLM ($12.30 USD)</code></li>
    <li><strong>Copilot Stated Collateral:</strong> <code>139.39 XLM ($25.03 USD)</code> &rarr; <em>Attempting to withdraw 139.39 XLM will revert on chain!</em></li>
  </ul>
</div>

<div class="section-title">Comparative Audit Matrix (All 3 Test Runs)</div>
<table class="data-table">
  <thead>
    <tr>
      <th style="width: 20%;">Prompt</th>
      <th style="width: 15%;">Classification</th>
      <th style="width: 35%;">Observed Behavior</th>
      <th style="width: 30%;">Root Cause Code Location</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>how much xlm can i withdraw as i dont have...</code></td>
      <td><span class="fail-tag">PARTIAL / REFUSED</span></td>
      <td>Shows wallet only (3.85 XLM); leaks goal objective to card title; deadlocks at [Start over].</td>
      <td><code>service.ts</code> &amp; <code>flash.ts</code> (missing Margin/Earn read fan-out; circular intent unhandled).</td>
    </tr>
    <tr>
      <td><code>withdraw 5k xlm</code></td>
      <td><span class="fail-tag">SILENT DROP</span></td>
      <td>Model parses 5,000 XLM, but 0 steps compiled; no action proposed; deadlocks at [Start over].</td>
      <td><code>quantities.ts:50</code> (<code>!text.includes(amount)</code> fails on '5k') &amp; <code>requested-actions.ts</code>.</td>
    </tr>
    <tr>
      <td><code>how much xlm can i withdraw?</code></td>
      <td><span class="fail-tag">WRONG</span></td>
      <td>Claims 139.39 XLM is posted collateral (sums 70.91 collateral + 68.48 debt); contract revert risk.</td>
      <td><code>facts-by-shape.ts</code> &amp; <code>flash.ts</code> (conflates SAC token balance/debt with posted collateral).</td>
    </tr>
  </tbody>
</table>

<div class="section-title">Actionable Production Remediation</div>
<div class="card">
  <div class="card-title">Three Core Fixes</div>
  <ul>
    <li><strong>Fix 1 (Collateral Isolation):</strong> Enforce <code>withdrawable = min(posted_collateral, max_withdrawable_at_floor)</code>. Collateral is strictly read from <code>vanna_margin_status · collateral</code>; borrowed liabilities must never be added to collateral assets.</li>
    <li><strong>Fix 2 (Unit Multipliers in quantities.ts):</strong> Support <code>k</code>/<code>m</code>/<code>b</code> in token quantity spans so <code>5k xlm</code> resolves cleanly without throwing <code>unanchored_amount</code>.</li>
    <li><strong>Fix 3 (Multi-Bucket Disambiguation):</strong> When a user asks a circular withdrawal/deposit question, fan out reads across Wallet, Margin, and Earn, and present an interactive clarification dialogue.</li>
  </ul>
</div>

<div style="margin-top: 16px; padding-top: 6px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 9.5px; color: #94a3b8;">
  <span>Vanna Copilot Quality Assurance &amp; Verification Suite</span>
  <span>Document Generated: September 13, 2026</span>
</div>

</body>
</html>"""

p = sync_playwright().start()
b = p.chromium.launch()
pg = b.new_page()
pg.set_content(html, wait_until="networkidle")
pg.pdf(
    path=str(out_pdf),
    format="A4",
    print_background=True,
    margin={"top": "10mm", "bottom": "10mm", "left": "10mm", "right": "10mm"}
)
b.close()
p.stop()

print("Comprehensive PDF generated successfully at:", out_pdf)
print("File size (bytes):", out_pdf.stat().st_size)
