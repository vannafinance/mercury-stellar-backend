import os
import base64
from pathlib import Path
from playwright.sync_api import sync_playwright

# 1. Load images as base64
p1 = Path("docs/copilot/runs/fail-prompt-withdraw-xlm.png")
p2 = Path("docs/copilot/runs/fail-prompt-withdraw-5k-xlm.png")
p3_copilot = Path("docs/copilot/runs/fail-prompt-how-much-xlm-withdraw.png")
p3_margin = Path("docs/copilot/runs/margin-page-positions-discrepancy.png")
p3_info = Path("docs/copilot/runs/margin-account-info.png")
p4_repay = Path("docs/copilot/runs/margin-repay-loan-available-blusdc.png")
p4_copilot = Path("docs/copilot/runs/fail-prompt-clear-debt-deposit-2xlm.png")
p5_copilot = Path("docs/copilot/runs/fail-prompt-clear-all-my-debt.png")
p6_copilot = Path("docs/copilot/runs/fail-prompt-use-margin-funds-repay-deposit-2xlm.png")
p7_copilot = Path("docs/copilot/runs/refusal-blend-pool-remove-10k-xlm.png")

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
with open(p4_repay, "rb") as f:
    img4_r_b64 = base64.b64encode(f.read()).decode("utf-8")
with open(p4_copilot, "rb") as f:
    img4_c_b64 = base64.b64encode(f.read()).decode("utf-8")
with open(p5_copilot, "rb") as f:
    img5_c_b64 = base64.b64encode(f.read()).decode("utf-8")
with open(p6_copilot, "rb") as f:
    img6_c_b64 = base64.b64encode(f.read()).decode("utf-8")
with open(p7_copilot, "rb") as f:
    img7_c_b64 = base64.b64encode(f.read()).decode("utf-8")

DESKTOP_PDF = Path(r"C:/Users/akgam/Desktop/Failed_Prompt_Tests_Comprehensive_Report.pdf")

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Vanna Copilot - Unified Prompt Battery Audit Report</title>
<style>
  @page {{
    size: A4;
    margin: 10mm 12mm 10mm 12mm;
  }}
  * {{
    box-sizing: border-box;
  }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #0f172a;
    background-color: #ffffff;
    line-height: 1.40;
    font-size: 11.2px;
    margin: 0;
    padding: 0;
  }}
  .header-bar {{
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 2px solid #e2e8f0;
    padding-bottom: 8px;
    margin-bottom: 10px;
  }}
  .logo-title {{
    font-size: 17px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: #0f172a;
  }}
  .logo-subtitle {{
    font-size: 9.5px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    margin-top: 1px;
  }}
  .badge-failed {{
    background: #fef2f2;
    color: #991b1b;
    border: 1.5px solid #ef4444;
    padding: 3px 8px;
    border-radius: 6px;
    font-weight: 800;
    font-size: 10px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }}
  .meta-grid {{
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 7px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 7px 9px;
    margin-bottom: 10px;
  }}
  .meta-item {{
    display: flex;
    flex-direction: column;
  }}
  .meta-label {{
    font-size: 8px;
    font-weight: 700;
    color: #64748b;
    text-transform: uppercase;
  }}
  .meta-val {{
    font-size: 10px;
    font-weight: 600;
    color: #1e293b;
    font-family: 'JetBrains Mono', Consolas, monospace;
  }}
  .section-title {{
    font-size: 12px;
    font-weight: 700;
    color: #0f172a;
    border-bottom: 1px solid #cbd5e1;
    padding-bottom: 2px;
    margin-top: 10px;
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }}
  .prompt-box {{
    background: #f1f5f9;
    border-left: 4px solid #3b82f6;
    border-radius: 0 6px 6px 0;
    padding: 7px 10px;
    margin-bottom: 8px;
  }}
  .prompt-tag {{
    font-size: 8.5px;
    font-weight: 800;
    color: #2563eb;
    text-transform: uppercase;
    margin-bottom: 2px;
  }}
  .prompt-text {{
    font-size: 12px;
    font-weight: 700;
    color: #0f172a;
    font-family: 'JetBrains Mono', Consolas, monospace;
  }}
  .screenshot-container {{
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    overflow: hidden;
    background: #090d16;
    padding: 4px;
    margin-bottom: 3px;
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
    font-size: 9px;
    color: #64748b;
    text-align: center;
    margin-bottom: 8px;
    font-style: italic;
  }}
  table.data-table {{
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 10px;
    font-size: 10px;
    page-break-inside: avoid;
  }}
  table.data-table th {{
    background: #f1f5f9;
    color: #475569;
    text-align: left;
    padding: 4px 6px;
    font-weight: 700;
    border-bottom: 1px solid #cbd5e1;
    border-top: 1px solid #e2e8f0;
    text-transform: uppercase;
    font-size: 8.5px;
    letter-spacing: 0.03em;
  }}
  table.data-table td {{
    padding: 4px 6px;
    border-bottom: 1px solid #e2e8f0;
    vertical-align: top;
  }}
  .fail-tag {{
    background: #fef2f2;
    color: #b91c1c;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid #fca5a5;
    font-size: 8.5px;
    display: inline-block;
  }}
  .pass-tag {{
    background: #f0fdf4;
    color: #15803d;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid #86efac;
    font-size: 8.5px;
    display: inline-block;
  }}
  .card {{
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 7px 9px;
    margin-bottom: 6px;
    page-break-inside: avoid;
  }}
  .card-title {{
    font-weight: 700;
    font-size: 10.5px;
    color: #1e293b;
    margin-bottom: 3px;
    display: flex;
    justify-content: space-between;
  }}
  .alert-warning {{
    background: #fffbeb;
    border: 1px solid #fcd34d;
    border-left: 4px solid #f59e0b;
    border-radius: 0 6px 6px 0;
    padding: 6px 8px;
    margin-bottom: 8px;
    font-size: 10px;
    page-break-inside: avoid;
  }}
  .discrepancy-card {{
    background: #fef2f2;
    border: 1.5px solid #f87171;
    border-radius: 6px;
    padding: 7px 10px;
    margin-bottom: 8px;
    page-break-inside: avoid;
  }}
  .math-formula {{
    background: #ffffff;
    border: 1px solid #fca5a5;
    border-radius: 5px;
    padding: 5px 8px;
    font-family: 'JetBrains Mono', Consolas, monospace;
    font-size: 11px;
    font-weight: 700;
    color: #b91c1c;
    text-align: center;
    margin: 4px 0;
  }}
  .page-break {{
    page-break-before: always;
  }}
  code {{
    background: #f1f5f9;
    padding: 1px 3px;
    border-radius: 3px;
    font-family: 'JetBrains Mono', Consolas, monospace;
    font-size: 10px;
    color: #0f172a;
  }}
  ul {{
    margin: 2px 0 5px 12px;
    padding: 0;
  }}
  li {{
    margin-bottom: 2px;
  }}
  .footer-note {{
    margin-top: 10px;
    padding-top: 4px;
    border-top: 1px solid #e2e8f0;
    display: flex;
    justify-content: space-between;
    font-size: 9px;
    color: #94a3b8;
  }}
</style>
</head>
<body>

<!-- ================= PAGE 1: EXECUTIVE AUDIT SUITE OVERVIEW ================= -->
<div class="header-bar">
  <div>
    <div class="logo-title">VANNA COPILOT ORCHESTRATOR</div>
    <div class="logo-subtitle">Comprehensive Prompt Battery Audit Report · All 7 Incidents Unified</div>
  </div>
  <div>
    <span class="badge-failed">STATUS: AUDITED · 7 INCIDENTS INVESTIGATED</span>
  </div>
</div>

<div class="meta-grid">
  <div class="meta-item">
    <span class="meta-label">Audit Suite Ref</span>
    <span class="meta-val">BATTERY-FAIL-SUITE-FULL</span>
  </div>
  <div class="meta-item">
    <span class="meta-label">Environment</span>
    <span class="meta-val">Soroban Testnet / Privy Account</span>
  </div>
  <div class="meta-item">
    <span class="meta-label">Branch & Commit</span>
    <span class="meta-val">copilot-upgrade @ 4448475</span>
  </div>
  <div class="meta-item">
    <span class="meta-label">Protocol Invariant</span>
    <span class="meta-val">HF &gt; 1.10 (LIQ_THRESHOLD_WAD)</span>
  </div>
</div>

<div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; padding: 5px 8px; margin-bottom: 6px;">
  <div style="font-weight: 700; color: #1e40af; font-size: 10px; margin-bottom: 1px;">Executive Summary</div>
  <div style="font-size: 9.5px; line-height: 1.35;">
    This unified audit report details seven consecutive prompt test investigations on the running <code>/copilot</code> orchestrator, covering XLM withdrawal, margin collateral valuation, debt repayment, and Blend pool liquidity removal. The findings reveal critical mechanistic defects in:
    (1) Multi-bucket read fan-out and circular intent resolution; (2) String-based unit quantity anchoring rejecting standard financial abbreviations like <code>5k</code>; (3) A critical mathematical hallucination where borrowed debt was added directly to posted collateral ($70.91 + 68.48 = 139.39$ XLM), creating an immediate contract revert risk; (4) An erroneous assumption in the planner forcing multi-leg debt repayments to be funded from the external wallet; (5) Erroneous rejection of all-debt clearance across multiple assets, refusing to spend available margin account funds (502.40 BLUSDC) to pay off 186.73 BLUSDC debt; (6) Conversational margin debt repayment refusal where despite explicit user instruction and perfect NLU intent recognition (<code>[Pay off outstanding margin debt with margin account funds]</code>), the deterministic compiler still rejected the solvent plan demanding external wallet funds; and (7) Unexecutable action refusal on Blend liquidity removal (<code>Remove 10k XLM liquidity from Blend pool.</code>) where despite on-chain capability in <code>BlendService.withdrawFromBlendPool</code> and on the <code>/farm</code> UI, the compiler omitted <code>withdraw_from_blend</code> from <code>WORKFLOW_OPS</code>, resulting in an unresolved capability limitation and a deadlocked <code>[Start over]</code> screen without navigation guidance.
  </div>
</div>

<div class="section-title">Master Executive Test Matrix (All 7 Evaluated Prompts)</div>
<table class="data-table">
  <thead>
    <tr>
      <th style="width: 3%;">#</th>
      <th style="width: 25%;">Prompt Under Test</th>
      <th style="width: 13%;">Classification</th>
      <th style="width: 32%;">Observed Behavior & Symptoms</th>
      <th style="width: 27%;">Root Cause Mechanism</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>1</strong></td>
      <td><code>how much xlm can i withdraw as i dont have an xlm balance in my margin account to deposit so withdraw some so i can deposit it</code></td>
      <td><span class="fail-tag">PARTIAL / REFUSED</span></td>
      <td>Answers only wallet (3.85 XLM); leaks internal planner objective as title; deadlocks at <code>[Start over]</code> with 0 options.</td>
      <td><code>service.ts</code> & <code>flash.ts</code>: Missing Margin/Earn read fan-out; circular user intent unhandled.</td>
    </tr>
    <tr>
      <td><strong>2</strong></td>
      <td><code>withdraw 5k xlm</code></td>
      <td><span class="fail-tag">SILENT DROP</span></td>
      <td>Model parses 5,000 XLM, but 0 proposal steps compiled; deadlocks at <code>[Start over]</code> with 0 options.</td>
      <td><code>quantities.ts:50</code>: <code>!text.includes(amount)</code> fails on '5k'; silently caught in <code>requested-actions.ts</code>.</td>
    </tr>
    <tr>
      <td><strong>3</strong></td>
      <td><code>how much xlm can i withdraw?</code></td>
      <td><span class="fail-tag">CRITICAL WRONG</span></td>
      <td>Claims 139.39 XLM is posted collateral and fully withdrawable; live Margin page shows only 70.91 XLM collateral.</td>
      <td><code>facts-by-shape.ts</code> / LLM: Summed posted collateral (70.91) + borrowed debt (68.48) = 139.39 XLM.</td>
    </tr>
    <tr>
      <td><strong>4</strong></td>
      <td><code>clear all my current debt but keep my collateral and then deposit 2 xlm</code></td>
      <td><span class="fail-tag">REFUSED WRONGLY</span></td>
      <td>Demands spendable BLUSDC in wallet to repay debt, ruling out plan; margin account holds 502.40 BLUSDC (covers debt).</td>
      <td><code>plan.ts:expandLegs</code>: Converted <code>all_position</code> repay to wallet <code>deposit_collateral</code> (<code>all_idle</code>); broke margin balance repay.</td>
    </tr>
    <tr>
      <td><strong>5</strong></td>
      <td><code>clear all my debt</code></td>
      <td><span class="fail-tag">REFUSED WRONGLY</span></td>
      <td>Identifies multi-asset debt (BLUSDC, XLM, AQUSDC), but rules out entire plan demanding wallet BLUSDC; margin holds 502.40 BLUSDC.</td>
      <td><code>plan.ts:expandLegs</code>: Injected mandatory wallet deposit on multi-asset debt repay; failed solvency evaluation despite 269% coverage.</td>
    </tr>
    <tr>
      <td><strong>6</strong></td>
      <td><code>Hey, can you use the funds sitting in my margin account to pay off what I owe, and deposit 2 XLM from my wallet as extra buffer?</code></td>
      <td><span class="fail-tag">REFUSED WRONGLY</span></td>
      <td>Model accurately assigns badge <code>[Pay off outstanding margin debt with margin account funds]</code>, but compiler still rules out plan demanding 186.73 BLUSDC from wallet.</td>
      <td><code>plan.ts:expandLegs</code>: Downstream deterministic compiler unconditionally forces wallet deposit leg (all_idle), ignoring margin account balance and overriding NLU intent. (Direct link to Incidents 4 &amp; 5).</td>
    </tr>
    <tr>
      <td><strong>7</strong></td>
      <td><code>Remove 10k XLM liquidity from Blend pool.</code></td>
      <td><span class="fail-tag">UNRESOLVED / UX DEADLOCK</span></td>
      <td>Identifies venue (Blend), asset (XLM), and remove action, but states withdrawing from Blend is not an executable write operation; deadlocks at <code>[Start over]</code>.</td>
      <td><code>workflow/types.ts</code>: <code>withdraw_from_blend</code> omitted from <code>WORKFLOW_OPS</code>; missing from <code>allowlist.ts</code>; UX lacks redirect to <code>/farm</code>.</td>
    </tr>
  </tbody>
</table>

<div class="alert-warning">
  <strong>DeFi Protocol Law & Non-Custodial Safety Invariants:</strong>
  Under Vanna Soroban Protocol V1:
  (1) Hard liquidation line HF &le; 1.10 is protocol law (<code>LIQUIDATION_THRESHOLD_WAD</code>);
  (2) Safety floors belong exclusively to the user (arbitrary defaults like 1.30 must never be injected);
  (3) Three-bucket liquidity (Spendable Wallet, Posted Margin, Earn Pools) must never be conflated;
  (4) Liabilities (debt) must NEVER be added to assets (collateral);
  (5) The margin smart account spends its own internal token balance on <code>vanna_repay</code>; wallet deposits are only required if there is a verified funding deficit;
  (6) Unsupported protocol operations must offer transparent navigation fallbacks to the corresponding Web UI page.
</div>

<div class="footer-note">
  <span>Vanna Copilot QA & Audit Suite · Master Document</span>
  <span>Page 1 of 11</span>
</div>

<!-- ================= PAGE 2: INCIDENT 1 DEEP-DIVE ================= -->
<div class="page-break"></div>

<div class="header-bar">
  <div>
    <div class="logo-title">INCIDENT 1: CIRCULAR MULTI-BUCKET READ & OBJECTIVE LEAKAGE</div>
    <div class="logo-subtitle">Telemetry, Telemetry State & Failure Classification</div>
  </div>
  <div><span class="fail-tag">RESULT: PARTIAL / REFUSED-WRONGLY</span></div>
</div>

<div class="section-title">1.1 Evaluated Prompt</div>
<div class="prompt-box">
  <div class="prompt-tag">User Input via /copilot Surface</div>
  <div class="prompt-text">how much xlm can i withdraw as i dont have an xlm balance in my margin account to deposit so withdraw some so i can deposit it</div>
</div>

<div class="section-title">1.2 Empirical Runtime Screenshot</div>
<div class="screenshot-container">
  <img class="screenshot-img" src="data:image/png;base64,{img1_b64}" alt="Incident 1 Screenshot" />
</div>
<div class="caption">Figure 1.0: Verbatim screenshot on /copilot interface illustrating leaked planner objective, solitary wallet finding, zero proposal options, and deadlocked 'Start over' state.</div>

<div class="section-title">1.3 Verbatim Telemetry Audit</div>
<table class="data-table">
  <thead>
    <tr>
      <th style="width: 25%;">UI Field</th>
      <th style="width: 45%;">Rendered Value (Verbatim)</th>
      <th style="width: 30%;">Audit Verdict</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Stated Finding</strong></td>
      <td><code>"Your wallet holds 3.8553269 XLM."</code></td>
      <td><span class="fail-tag">DEFICIENT</span> Reads wallet only; completely omits Margin & Earn positions</td>
    </tr>
    <tr>
      <td><strong>Notice Header</strong></td>
      <td><code>"This thread is kept in this browser tab..."</code></td>
      <td><span class="pass-tag">NOMINAL</span> Standard browser session lifecycle warning</td>
    </tr>
    <tr>
      <td><strong>Card Headline</strong></td>
      <td><code>"Determine withdrawable XLM amount and clarify existing margin collateral and wallet balances."</code></td>
      <td><span class="fail-tag">LEAKED GOAL</span> Emitted internal orchestrator objective as user-facing title</td>
    </tr>
    <tr>
      <td><strong>Latency Banner</strong></td>
      <td><code>"Checked in 21s · 1m 01s this device"</code></td>
      <td><span class="pass-tag">EMPIRICAL</span> Real runtime values logged accurately</td>
    </tr>
    <tr>
      <td><strong>Action Proposal</strong></td>
      <td><code>[Start over]</code> (Zero execution/plan buttons)</td>
      <td><span class="fail-tag">DEADLOCK</span> No options prepared; user trapped on terminal screen</td>
    </tr>
  </tbody>
</table>

<div class="section-title">1.4 Root Cause Breakdown</div>
<div class="card">
  <div class="card-title"><span>Failure Mechanisms in Incident 1</span><span class="fail-tag">PLANNER GAP</span></div>
  <ul>
    <li><strong>Unanswered Core Question:</strong> The prompt explicitly asked <em>"how much xlm can i withdraw"</em>. The copilot failed to compute or return any withdrawable amount, headroom range, or redeemable balance.</li>
    <li><strong>Internal Objective Leakage:</strong> The headline rendered verbatim the LLM planning objective from <code>outcome.goal.objective</code> instead of answering the user.</li>
    <li><strong>Circular User Paradox Dropped:</strong> The user stated <em>"as i dont have an xlm balance in my margin account to deposit so withdraw some so i can deposit it"</em>. The copilot neither explained that margin funds cannot be withdrawn to deposit back into margin, nor asked if they wanted to redeem from Earn.</li>
  </ul>
</div>

<div class="footer-note">
  <span>Vanna Copilot QA & Audit Suite · Master Document</span>
  <span>Page 2 of 11</span>
</div>

<!-- ================= PAGE 3: INCIDENT 2 DEEP-DIVE ================= -->
<div class="page-break"></div>

<div class="header-bar">
  <div>
    <div class="logo-title">INCIDENT 2: '5K' MULTIPLIER DROPPED BY TOKEN ANCHOR</div>
    <div class="logo-subtitle">Unit Parsing Defect & Silent Step Dropping</div>
  </div>
  <div><span class="fail-tag">RESULT: SILENT COMPILER FAILURE</span></div>
</div>

<div class="section-title">2.1 Evaluated Prompt</div>
<div class="prompt-box">
  <div class="prompt-tag">User Input via /copilot Surface</div>
  <div class="prompt-text">withdraw 5k xlm</div>
</div>

<div class="section-title">2.2 Empirical Runtime Screenshot</div>
<div class="screenshot-container">
  <img class="screenshot-img" src="data:image/png;base64,{img2_b64}" alt="Incident 2 Screenshot" />
</div>
<div class="caption">Figure 2.0: Verbatim screenshot on /copilot illustrating literal action understanding ('Withdraw 5,000 XLM from margin collateral') followed by silent compilation failure, zero execution proposal steps, and terminal 'Start over' button.</div>

<div class="section-title">2.3 Verbatim Telemetry Audit</div>
<table class="data-table">
  <thead>
    <tr>
      <th style="width: 25%;">UI Field</th>
      <th style="width: 45%;">Rendered Value (Verbatim)</th>
      <th style="width: 30%;">Audit Verdict</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Stated Finding</strong></td>
      <td><code>"User requested withdrawal of 5,000 XLM collateral from margin account."</code></td>
      <td><span class="pass-tag">ACCURATE</span> Model correctly converted '5k' to 5,000</td>
    </tr>
    <tr>
      <td><strong>Card Headline</strong></td>
      <td><code>"Withdraw 5,000 XLM from margin collateral."</code></td>
      <td><span class="pass-tag">CORRECT GOAL</span> Accurately identified financial intent</td>
    </tr>
    <tr>
      <td><strong>Latency Banner</strong></td>
      <td><code>"Checked in 12s · 22s this device"</code></td>
      <td><span class="pass-tag">REAL VALUES</span> Fast turn 1 research</td>
    </tr>
    <tr>
      <td><strong>Action Proposal</strong></td>
      <td><code>[Start over]</code> (Zero execution buttons, no proposal card)</td>
      <td><span class="fail-tag">SILENT DROP</span> Action compiled to 0 steps; terminal deadlock</td>
    </tr>
  </tbody>
</table>

<div class="section-title">2.4 Code-Level Root Cause: The Substring Anchoring Bug</div>
<div class="card">
  <div class="card-title"><span>Tracing quantities.ts line 50 & requested-actions.ts</span><span class="fail-tag">COMPILER DEFECT</span></div>
  <p>The model produced <code>amount: "5000"</code> and <code>sourceQuote: "5k xlm"</code>. In <code>requested-actions.ts:29</code>, the compiler verified token quantity anchoring via <code>isTokenAmountIn(action.sourceQuote, action.amount)</code>.</p>
  <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 5px 8px; margin: 3px 0; font-family: monospace; font-size: 10px;">
    // lib/copilot/investigation/quantities.ts line 50<br>
    export function isTokenAmountIn(text: string, amount: string): boolean {{<br>
    &nbsp;&nbsp;if (!amount || !text.includes(amount)) return false; // &larr; FAILS on '5k xlm'
  </div>
  <p>Because <code>"5k xlm".includes("5000")</code> is <strong>false</strong>, <code>isTokenAmountIn</code> threw <code>unanchored_amount</code>. In <code>requested-actions.ts</code>, a bare <code>catch {{ return []; }}</code> swallowed the exception, returning 0 steps. The copilot fell through to rendering findings with 0 proposals and deadlocked at <code>[Start over]</code>.</p>
</div>

<div class="footer-note">
  <span>Vanna Copilot QA & Audit Suite · Master Document</span>
  <span>Page 3 of 11</span>
</div>

<!-- ================= PAGE 4: INCIDENT 3 GROUND TRUTH COMPARISON ================= -->
<div class="page-break"></div>

<div class="header-bar">
  <div>
    <div class="logo-title">INCIDENT 3: CONFIDENT COLLATERAL HALLUCINATION</div>
    <div class="logo-subtitle">Copilot Response vs Margin Page Live Ground Truth</div>
  </div>
  <div><span class="badge-failed">RESULT: WRONG (CRITICAL MATH DEFECT)</span></div>
</div>

<div class="section-title">3.1 Evaluated Prompt</div>
<div class="prompt-box">
  <div class="prompt-tag">User Input via /copilot Surface</div>
  <div class="prompt-text">how much xlm can i withdraw?</div>
</div>

<div class="section-title">3.2 Copilot Claim (Verbatim UI Screenshot)</div>
<div class="screenshot-container">
  <img class="screenshot-img" src="data:image/png;base64,{img3_c_b64}" alt="Copilot Claim" />
</div>
<div class="caption">Figure 3.1: Copilot claims posted XLM collateral is <strong>~139.39 XLM ($25.03 USD)</strong> and fully available for withdrawal.</div>

<div class="section-title">3.3 Margin Page Live Ground Truth (Screenshots Directly Below)</div>
<div class="screenshot-container">
  <img class="screenshot-img" src="data:image/png;base64,{img3_m_b64}" alt="Margin Page Positions Table" />
</div>
<div class="caption">Figure 3.2: Vanna Margin page positions table showing actual Collateral Deposited XLM: <strong>70.91 XLM ($12.73)</strong> and Borrowed Assets XLM: <strong>68.48 XLM ($12.30)</strong>.</div>

<div class="screenshot-container" style="max-width: 70%; margin: 0 auto;">
  <img class="screenshot-img" src="data:image/png;base64,{img3_i_b64}" alt="Margin Account Info" />
</div>
<div class="caption">Figure 3.3: Vanna Margin Account Info header showing Total Borrowed $210.55, Net Available Collateral $4.28K, Net Health Factor 21.34.</div>

<div class="footer-note">
  <span>Vanna Copilot QA & Audit Suite · Master Document</span>
  <span>Page 4 of 11</span>
</div>

<!-- ================= PAGE 5: MATHEMATICAL PROOF & PROTOCOL INVARIANTS ================= -->
<div class="page-break"></div>

<div class="header-bar">
  <div>
    <div class="logo-title">MATHEMATICAL PROOF & DEFI PROTOCOL INVARIANTS</div>
    <div class="logo-subtitle">Empirical Discrepancy Breakdown & Multi-Bucket Balance Rules</div>
  </div>
  <div><span class="fail-tag">CONTRACT REVERT RISK</span></div>
</div>

<div class="section-title">4.1 Mathematical Proof of Defect: Debt Added to Collateral</div>
<div class="discrepancy-card">
  <div style="font-weight: 800; color: #991b1b; font-size: 11px; margin-bottom: 3px;">
    EXACT MATHEMATICAL RECONSTRUCTION
  </div>
  <p>Comparing the live Margin page positions table against the Copilot response proves the exact mathematical bug:</p>
  <ul>
    <li><strong>Live Deposited XLM Collateral (Margin Page):</strong> <code>70.91 XLM ($12.73 USD)</code></li>
    <li><strong>Live Borrowed XLM Liability (Debt on Margin Page):</strong> <code>68.48 XLM ($12.30 USD)</code></li>
  </ul>
  <div class="math-formula">
    70.91 XLM (Deposited Collateral) + 68.48 XLM (Borrowed Debt) = 139.39 XLM ($25.03 USD)
  </div>
  <p style="font-size: 10.5px; color: #991b1b; margin-top: 3px;">
    <strong>Conclusion:</strong> The Copilot computed total account tokens by adding the user's collateral <em>plus</em> their debt, and stated that this entire sum (139.39 XLM) was posted collateral available for withdrawal.
  </p>
</div>

<div class="section-title">4.2 Ground Truth vs Copilot Stated Response</div>
<table class="data-table">
  <thead>
    <tr>
      <th style="width: 25%;">Position Parameter</th>
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

<div class="section-title">4.3 Three-Bucket Liquidity Isolation & Protocol Law</div>
<table class="data-table">
  <thead>
    <tr>
      <th style="width: 25%;">Liquidity Bucket</th>
      <th style="width: 35%;">Observed Position State</th>
      <th style="width: 40%;">Protocol Constraint & Behavioral Law</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>1. Spendable Wallet</strong><br>(Native Stellar)</td>
      <td>Holds <code>3.8553269 XLM</code> total</td>
      <td><strong>Reserve Locked:</strong> Stellar base reserve (0.5 XLM) + trustlines + fee reserve (~0.1 XLM) leaves near zero spendable. Cannot size deposits without external funding.</td>
    </tr>
    <tr>
      <td><strong>2. Margin Collateral</strong><br>(Vanna Smart Account)</td>
      <td>Posted in <code>AccountManager</code>: <strong>70.91 XLM</strong></td>
      <td><strong>Hard Balance Ceiling:</strong> Withdrawable collateral can NEVER exceed 70.91 XLM. Withdrawing collateral down to $HF &gt; 1.10$ is permitted, but cannot exceed posted assets.</td>
    </tr>
    <tr>
      <td><strong>3. Earn Lending Pool</strong><br>(vToken Holdings)</td>
      <td>vToken positions in <code>LendingPool</code></td>
      <td><strong>Redeemable:</strong> vTokens are redeemable to spendable wallet and can then be deposited as collateral. Copilot omitted reading this bucket.</td>
    </tr>
  </tbody>
</table>

<div class="footer-note">
  <span>Vanna Copilot QA & Audit Suite · Master Document</span>
  <span>Page 5 of 11</span>
</div>

<!-- ================= PAGE 6: INCIDENT 4 EVIDENCE & CHAT REFUSAL ================= -->
<div class="page-break"></div>

<div class="header-bar">
  <div>
    <div class="logo-title">INCIDENT 4: ERRONEOUS WALLET REQUIREMENT ON REPAY + DEPOSIT</div>
    <div class="logo-subtitle">Battery Case D10 ★ · Live Repay UI vs Copilot Refusal</div>
  </div>
  <div><span class="fail-tag">REFUSED WRONGLY</span></div>
</div>

<div class="prompt-box">
  <div class="prompt-tag">Evaluated User Prompt</div>
  <div class="prompt-text">clear all my current debt but keep my collateral and then deposit 2 xlm</div>
</div>

<div class="section-title">5.1 Copilot Chat Response & Erroneous Refusal</div>
<div class="screenshot-container">
  <img class="screenshot-img" style="max-height: 165px; width: auto;" src="data:image/png;base64,{img4_c_b64}" alt="Incident 4 Chat Refusal Screenshot" />
</div>
<div class="caption">Figure 4.1: Copilot chat response ruling out the plan because the wallet holds no spendable BLUSDC, ignoring available margin account funds.</div>

<div class="section-title">5.2 Margin Page Repay Loan Tab Ground Truth</div>
<div class="screenshot-container">
  <img class="screenshot-img" style="max-height: 165px; width: auto;" src="data:image/png;base64,{img4_r_b64}" alt="Margin Page Repay Loan Tab" />
</div>
<div class="caption">Figure 4.2: Live Margin Page "Repay Loan" tab displaying Net Outstanding Amount to Repay: <strong>186.73 BLUSDC</strong> (~$186.77) and Available Balance in Margin Account: <strong>502.40 BLUSDC</strong> (~$502.49).</div>

<div class="section-title">5.3 Telemetry Summary for Incident 4</div>
<table class="data-table">
  <thead>
    <tr>
      <th style="width: 25%;">UI Field</th>
      <th style="width: 45%;">Rendered Value (Verbatim)</th>
      <th style="width: 30%;">Audit Verdict</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Ruled-Out Reason</strong></td>
      <td><code>"deposit collateral BLUSDC: you owe 186.7329819 BLUSDC (~$186.76) and the wallet holds no spendable BLUSDC — add 186.7329819 BLUSDC to the wallet, or redeem it from Earn first."</code></td>
      <td><span class="fail-tag">DEFECTIVE</span> Erroneously demands wallet BLUSDC when smart account has 502.40 BLUSDC</td>
    </tr>
    <tr>
      <td><strong>Plan Badges</strong></td>
      <td><code>[Keep existing collateral intact]</code> <code>[Clear all outstanding margin debt]</code> <code>[Deposit 2 XLM collateral]</code> <code>[No new borrowing]</code></td>
      <td><span class="pass-tag">ACCURATE</span> Model correctly recognized all user intents</td>
    </tr>
    <tr>
      <td><strong>Execution Outcome</strong></td>
      <td><code>[Start over]</code> (Zero execution options)</td>
      <td><span class="fail-tag">DEADLOCK</span> 100% solvent plan rejected</td>
    </tr>
  </tbody>
</table>

<div class="footer-note">
  <span>Vanna Copilot QA & Audit Suite · Master Document</span>
  <span>Page 6 of 11</span>
</div>

<!-- ================= PAGE 7: INCIDENT 5 DEEP-DIVE ================= -->
<div class="page-break"></div>

<div class="header-bar">
  <div>
    <div class="logo-title">INCIDENT 5: MULTI-ASSET DEBT CLEARANCE REFUSAL</div>
    <div class="logo-subtitle">Battery Case D11 ★ · Prompt 'clear all my debt' Blocked by Wallet Prerequisite</div>
  </div>
  <div><span class="fail-tag">REFUSED WRONGLY</span></div>
</div>

<div class="prompt-box">
  <div class="prompt-tag">Evaluated User Prompt</div>
  <div class="prompt-text">clear all my debt</div>
</div>

<div class="section-title">6.1 Copilot Chat Response & Erroneous Multi-Asset Refusal</div>
<div class="screenshot-container">
  <img class="screenshot-img" style="max-height: 185px; width: auto;" src="data:image/png;base64,{img5_c_b64}" alt="Incident 5 Chat Refusal Screenshot" />
</div>
<div class="caption">Figure 5.1: Verbatim screenshot on /copilot interface attempting to clear all debt across BLUSDC, XLM, and AQUSDC positions, but immediately ruled out because the external wallet holds 0 spendable BLUSDC.</div>

<div class="section-title">6.2 Verbatim Telemetry Audit for Incident 5</div>
<table class="data-table">
  <thead>
    <tr>
      <th style="width: 25%;">UI Field</th>
      <th style="width: 45%;">Rendered Value (Verbatim)</th>
      <th style="width: 30%;">Audit Verdict</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Headline Goal</strong></td>
      <td><code>"Repay all outstanding debt across BLUSDC, XLM, and AQUSDC positions."</code></td>
      <td><span class="pass-tag">EXACT GOAL</span> Correctly parsed multi-asset debt obligations</td>
    </tr>
    <tr>
      <td><strong>Plan Badges</strong></td>
      <td><code>[No new borrowing]</code></td>
      <td><span class="pass-tag">NOMINAL</span> Correct safety constraint applied</td>
    </tr>
    <tr>
      <td><strong>Ruled-Out Reason</strong></td>
      <td><code>"Ruled out — Repay all outstanding BLUSDC, XLM, and AQUSDC debt. deposit collateral BLUSDC: you owe 186.7342581 BLUSDC (~$186.76) and the wallet holds no spendable BLUSDC — add 186.7342581 BLUSDC to the wallet, or redeem it from Earn first."</code></td>
      <td><span class="fail-tag">DEFECTIVE</span> Evaluates wallet balance rather than smart account balance</td>
    </tr>
    <tr>
      <td><strong>Latency Banner</strong></td>
      <td><code>"Checked in 23s · 22s this device"</code></td>
      <td><span class="pass-tag">EMPIRICAL</span> Real runtime values logged accurately</td>
    </tr>
    <tr>
      <td><strong>Footnote Warning</strong></td>
      <td><code>"The Margin page snapshot and the contract liquidation snapshot disagree, so I did not quote a borrow size. Tokens sitting in the margin account that are not posted as collateral count toward the figure shown on the Margin page, but not toward what the liquidation engine sees."</code></td>
      <td><span class="pass-tag">DISAGREEMENT NOTE</span> Correctly identifies unposted tokens sitting in margin account</td>
    </tr>
  </tbody>
</table>

<div class="section-title">6.3 Why This Fails the Production Standard</div>
<div class="card">
  <div class="card-title"><span>Analysis of Multi-Asset Repayment Failure</span><span class="fail-tag">SOLVENT PLAN REJECTED</span></div>
  <ul>
    <li><strong>Internal Margin Balance Ignored:</strong> The user requested to clear debt. The margin smart account held 502.40 BLUSDC, which is 269% of the outstanding BLUSDC debt (186.73 BLUSDC). The copilot should have immediately executed <code>vanna_repay</code> using this internal balance.</li>
    <li><strong>Multi-Asset Cascade Halting:</strong> Because the sizer forced a wallet deposit leg on BLUSDC and failed, it never evaluated the subsequent XLM or AQUSDC repay legs or partial repayment options. The entire operation was killed instantly.</li>
    <li><strong>Terminal Deadlock:</strong> With zero viable options presented, the user is left with only <code>[Start over]</code> and forced to manually execute through the web UI.</li>
  </ul>
</div>

<div class="footer-note">
  <span>Vanna Copilot QA & Audit Suite · Master Document</span>
  <span>Page 7 of 11</span>
</div>

<!-- ================= PAGE 8: INCIDENT 6 DEEP-DIVE ================= -->
<div class="page-break"></div>

<div class="header-bar">
  <div>
    <div class="logo-title">INCIDENT 6: CONVERSATIONAL MARGIN REPAY REFUSAL</div>
    <div class="logo-subtitle">Battery Case D12 ★ · Explicit Margin Instruction vs Deterministic Compiler Fallacy</div>
  </div>
  <div><span class="fail-tag">REFUSED WRONGLY</span></div>
</div>

<div class="prompt-box">
  <div class="prompt-tag">Evaluated User Prompt</div>
  <div class="prompt-text">Hey, can you use the funds sitting in my margin account to pay off what I owe, and deposit 2 XLM from my wallet as extra buffer?</div>
</div>

<div class="section-title" style="margin-top: 6px; margin-bottom: 4px;">7.1 Copilot Chat Response & Telemetry Proof</div>
<div class="screenshot-container" style="padding: 3px; margin-bottom: 3px;">
  <img class="screenshot-img" style="max-height: 110px; width: auto;" src="data:image/png;base64,{img6_c_b64}" alt="Incident 6 Chat Refusal Screenshot" />
</div>
<div class="caption" style="margin-bottom: 5px;">Figure 6.1: Verbatim screenshot on /copilot showing model correctly recognizing the intent with badge [Pay off outstanding margin debt with margin account funds], yet the deterministic compiler still rejected the plan with: 'you owe 186.7376392 BLUSDC and the wallet holds no spendable BLUSDC'.</div>

<div class="section-title" style="margin-top: 6px; margin-bottom: 4px;">7.2 Verbatim Telemetry Audit for Incident 6</div>
<table class="data-table" style="margin-bottom: 6px;">
  <thead>
    <tr>
      <th style="width: 25%;">UI Field</th>
      <th style="width: 45%;">Rendered Value (Verbatim)</th>
      <th style="width: 30%;">Audit Verdict</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Headline Goal</strong></td>
      <td><code>"Deposit 2 XLM from the wallet into the margin account and repay all outstanding margin debts using account collateral."</code></td>
      <td><span class="pass-tag">EXACT GOAL</span> Dual ops parsed correctly</td>
    </tr>
    <tr>
      <td><strong>Plan Badges</strong></td>
      <td><code>[Pay off outstanding margin debt with margin account funds]</code> <code>[Deposit 2 XLM from wallet as extra buffer]</code> <code>[No new borrowing]</code></td>
      <td><span class="pass-tag">100% NLU ACCURACY</span> Margin repay isolated</td>
    </tr>
    <tr>
      <td><strong>Ruled-Out Reason</strong></td>
      <td><code>"Ruled out — Deposit 2 XLM buffer and repay all debt. deposit collateral BLUSDC: you owe 186.7376392 BLUSDC (~$186.77) and the wallet holds no spendable BLUSDC — add 186.7376392 BLUSDC to the wallet, or redeem it from Earn first."</code></td>
      <td><span class="fail-tag">DEFECTIVE COMPILER</span> Sizer ignored NLU badge</td>
    </tr>
    <tr>
      <td><strong>Latency Banner</strong></td>
      <td><code>"Checked in 28s · 27s this device"</code></td>
      <td><span class="pass-tag">EMPIRICAL</span> Verbatim latency telemetry</td>
    </tr>
    <tr>
      <td><strong>Execution Outcome</strong></td>
      <td><code>[Start over]</code> (Zero viable plan buttons)</td>
      <td><span class="fail-tag">TERMINAL DEADLOCK</span> Blocked despite 502.40 BLUSDC</td>
    </tr>
  </tbody>
</table>

<div class="section-title" style="margin-top: 6px; margin-bottom: 4px;">7.3 Architectural Proof: Direct Tie to Incident 4 & Compiler Fallacy</div>
<div class="card" style="padding: 5px 8px; margin-bottom: 4px;">
  <div class="card-title"><span>Why Conversational Phrasing Failed to Bypass the Bug</span><span class="fail-tag">COMPILER DEFECT</span></div>
  <ul>
    <li><strong>The Hypothesis:</strong> Following Incident 4 (where a concise prompt failed), the user hypothesized that conversational phrasing explicitly commanding the copilot to <em>"use the funds sitting in my margin account"</em> would guide the agent away from checking the external wallet.</li>
    <li><strong>NLU Succeeded, Compiler Failed:</strong> As proven by Figure 6.1, the LLM performed semantic parsing flawlessly, emitting the precise badge <code>[Pay off outstanding margin debt with margin account funds]</code>.</li>
    <li><strong>Downstream Hijack in <code>plan.ts:expandLegs</code>:</strong> The failure occurred entirely inside the deterministic TypeScript compiler. In <code>plan.ts:98</code>, <code>expandLegs()</code> unconditionally mapped any <code>repay</code> leg to <code>deposit_collateral (all_idle)</code> followed by <code>repay (previous_leg)</code>.</li>
    <li><strong>Generalized Solution:</strong> This proves conclusively that prompt engineering cannot fix this bug. The compiler mechanism must check the smart account token balance first, only injecting a wallet deposit for the net funding deficit: <code>max(0, debt - margin_balance)</code>.</li>
  </ul>
</div>

<div class="footer-note">
  <span>Vanna Copilot QA & Audit Suite · Master Document</span>
  <span>Page 8 of 11</span>
</div>

<!-- ================= PAGE 9: INCIDENT 7 DEEP-DIVE ================= -->
<div class="page-break"></div>

<div class="header-bar">
  <div>
    <div class="logo-title">INCIDENT 7: BLEND POOL LIQUIDITY REMOVAL REFUSAL & UX DEADLOCK</div>
    <div class="logo-subtitle">Battery Case E5 · Capability Allowlist Boundary & Missing Web Navigation</div>
  </div>
  <div><span class="fail-tag">UNRESOLVED · CAPABILITY BOUNDARY</span></div>
</div>

<div class="prompt-box">
  <div class="prompt-tag">Evaluated User Prompt</div>
  <div class="prompt-text">Remove 10k XLM liquidity from Blend pool.</div>
</div>

<div class="section-title" style="margin-top: 6px; margin-bottom: 4px;">8.1 Copilot Chat Response & Capability Refusal Screenshot</div>
<div class="screenshot-container" style="padding: 3px; margin-bottom: 3px;">
  <img class="screenshot-img" style="max-height: 125px; width: auto;" src="data:image/png;base64,{img7_c_b64}" alt="Incident 7 Blend Removal Refusal Screenshot" />
</div>
<div class="caption" style="margin-bottom: 5px;">Figure 7.1: Verbatim screenshot on /copilot showing perfect intent classification ([Venue requested: Blend], [Asset: XLM], [Requested action: remove/withdraw liquidity from Blend pool]), followed by capability limitation refusal and terminal deadlock at [Start over].</div>

<div class="section-title" style="margin-top: 6px; margin-bottom: 4px;">8.2 Verbatim Telemetry Audit for Incident 7</div>
<table class="data-table" style="margin-bottom: 6px;">
  <thead>
    <tr>
      <th style="width: 25%;">UI Field</th>
      <th style="width: 45%;">Rendered Value (Verbatim)</th>
      <th style="width: 30%;">Audit Verdict</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Plan Badges</strong></td>
      <td><code>[Venue requested: Blend]</code> <code>[Asset: XLM]</code> <code>[Requested action: remove/withdraw liquidity from Blend pool]</code> <code>[No new borrowing]</code></td>
      <td><span class="pass-tag">100% NLU ACCURACY</span> Venue, asset, and action parsed flawlessly</td>
    </tr>
    <tr>
      <td><strong>Card Headline / Banner</strong></td>
      <td><code>"UNRESOLVED — ANSWER OR REFINE YOUR REQUEST BELOW TO CONTINUE"</code></td>
      <td><span class="fail-tag">UNRESOLVED</span> Dropped execution plan; zero steps compiled</td>
    </tr>
    <tr>
      <td><strong>Stated Limitation</strong></td>
      <td><code>"Withdrawing or unsupplying liquidity from Blend is currently not an executable write operation."</code></td>
      <td><span class="pass-tag">SAFETY REFUSAL</span> Correctly enforces system capability boundary</td>
    </tr>
    <tr>
      <td><strong>Latency Banner</strong></td>
      <td><code>"Checked in 18s · 17s this device"</code></td>
      <td><span class="pass-tag">EMPIRICAL</span> Runtime logged accurately</td>
    </tr>
    <tr>
      <td><strong>Execution Outcome</strong></td>
      <td><code>[Start over]</code> (Zero execution buttons, no deep-link to /farm)</td>
      <td><span class="fail-tag">TERMINAL DEADLOCK</span> Traps user with no alternative path or UI guide</td>
    </tr>
  </tbody>
</table>

<div class="section-title" style="margin-top: 6px; margin-bottom: 4px;">8.3 Architectural Root Cause: Why Is Blend Removal Not An Executable Action?</div>
<div class="card" style="padding: 6px 10px; margin-bottom: 6px;">
  <div class="card-title"><span>Four-Layer Capability Boundary Breakdown</span><span class="fail-tag">ENGINEERING ANALYSIS</span></div>
  <ul>
    <li>
      <strong>1. Investigation Allowlist Omission (<code>lib/copilot/workflow/types.ts:9</code>):</strong>
      The multi-turn orchestrator strictly limits compiled proposals to <code>WORKFLOW_OPS = ["lend", "redeem", "deposit_collateral", "withdraw_collateral", "borrow", "repay", "supply_blend"]</code>. While <code>supply_blend</code> (putting funds in) was ported, <code>withdraw_from_blend</code> (pulling funds out) was never added to the allowed operations set.
    </li>
    <li>
      <strong>2. MCP Tool Whitelist Gatekeeper (<code>lib/copilot/workflow/allowlist.ts:7-11</code>):</strong>
      The multi-turn write validator <code>TOOLS</code> maps allowed ops to MCP tools (e.g. <code>supply_blend &rarr; vanna_blend_supply</code>). It contains no entry for <code>vanna_blend_withdraw</code>. Calling <code>allowedInvocation()</code> on a Blend withdrawal throws an immediate <code>write_not_allowed</code> runtime exception.
    </li>
    <li>
      <strong>3. NLU Model Adherence to System Prompt (<code>lib/copilot/investigation/flash.ts:151-153</code>):</strong>
      The model prompt explicitly commands: <em>"If the user's goal needs an operation not in this list, say so in findings as a limitation — name the unsupported step — and still propose the best plan the list allows... For unsupported actions explain the capability limitation."</em> The model faithfully followed protocol law by refusing to compile an unsupported write.
    </li>
    <li>
      <strong>4. On-Chain Capability Exists, Disconnected in Multi-Turn:</strong>
      On Soroban, smart contract execution is 100% operational via <code>BlendService.withdrawFromBlendPool()</code> (<code>lib/blend-utils.ts:384</code>) and live on the <strong>Farm</strong> web page (<code>/farm</code>). In the legacy single-turn router (<code>mcp-write.ts:976</code>), <code>withdraw_from_blend</code> was mapped to <code>vanna_blend_withdraw</code>. When the multi-turn architecture was built, it was deferred as a known capability boundary (Battery Case <code>E5</code>: <code>take my xlm out of blend | REFUSED-CORRECTLY</code>).
    </li>
    <li>
      <strong>5. The UX Defect (Terminal Deadlock):</strong>
      While refusing an unexecutable write is safety-correct to prevent misrouting funds, leaving the user on an <code>UNRESOLVED</code> screen with only <code>[Start over]</code> violates production copilot standards. The agent must provide an actionable exit: a direct interactive button to <code>[Open Farm Page (/farm)]</code> and step-by-step manual withdrawal instructions.
    </li>
  </ul>
</div>

<div class="footer-note">
  <span>Vanna Copilot QA & Audit Suite · Master Document</span>
  <span>Page 9 of 11</span>
</div>

<!-- ================= PAGE 10: THREE-BUCKET ARCHITECTURE & REPAYMENT MECHANICS ================= -->
<div class="page-break"></div>

<div class="header-bar">
  <div>
    <div class="logo-title">THREE-BUCKET ARCHITECTURE & REPAYMENT MECHANICS</div>
    <div class="logo-subtitle">Why Repay Shows 502.40 BLUSDC While Deposit Shows 0 & Sizer Root Cause</div>
  </div>
  <div><span class="fail-tag">ARCHITECTURE DEEP-DIVE</span></div>
</div>

<div class="section-title">9.1 Architectural Distinction: Spendable Wallet vs Margin Smart Account</div>
<div class="card">
  <div class="card-title"><span>Three-Bucket Liquidity Segregation</span><span class="pass-tag">SYSTEM INVARIANT</span></div>
  <p>The user asked why the <strong>Repay Loan</strong> section shows <strong>502.40 BLUSDC</strong> available in the margin account, but the <strong>Deposit</strong> section shows <strong>0 BLUSDC</strong>. The architectural explanation is fundamental to Soroban smart contracts:</p>
  <ul>
    <li>
      <strong>Deposit Section (Transfer Collateral · MB):</strong> Moves funds <em>from</em> the user's personal external wallet (Freighter / G-address) <em>into</em> the margin smart account. Because the personal wallet holds 0 BLUSDC, the deposit input correctly displays 0 available to deposit.
    </li>
    <li>
      <strong>Repay Loan Section:</strong> Displays the token balance <em>already sitting inside</em> the margin smart account (C-address) via <code>MarginAccountService.getMarginAccountTokenBalanceWad</code>. The 502.40 BLUSDC was received from prior borrowing or trades and resides inside the smart contract, available to repay debt immediately.
    </li>
  </ul>
</div>

<div class="section-title">9.2 Mathematical Solvency Breakdown</div>
<table class="data-table">
  <thead>
    <tr>
      <th style="width: 25%;">Position Parameter</th>
      <th style="width: 25%;">Amount / Value</th>
      <th style="width: 50%;">Execution Status & Availability</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Net BLUSDC Debt</strong></td>
      <td><strong>186.7342581 BLUSDC</strong> (~$186.76)</td>
      <td>Debt owed to the lending pool that user requested to clear.</td>
    </tr>
    <tr>
      <td><strong>Margin Account BLUSDC</strong></td>
      <td><strong>502.40 BLUSDC</strong> (~$502.49)</td>
      <td>Funds held inside smart account (C-address); covers debt by <strong>269%</strong>.</td>
    </tr>
    <tr>
      <td><strong>Surplus After Full Repay</strong></td>
      <td><strong>+315.67 BLUSDC</strong></td>
      <td>Remains in margin account after debt is fully cleared.</td>
    </tr>
    <tr>
      <td><strong>Spendable Wallet BLUSDC</strong></td>
      <td><strong>0.00 BLUSDC</strong></td>
      <td>Personal wallet holds 0 BLUSDC, but <strong>$0 is needed</strong> from the wallet!</td>
    </tr>
    <tr>
      <td><strong>Net XLM Debt</strong></td>
      <td><strong>68.48 XLM</strong> (~$12.30)</td>
      <td>Margin posted collateral: 70.91 XLM; Wallet: 3.85 XLM.</td>
    </tr>
    <tr>
      <td><strong>Net AQUSDC Debt</strong></td>
      <td><strong>11.50 AQUSDC</strong> (~$11.50)</td>
      <td>Margin posted collateral: 29.81 AQUSDC.</td>
    </tr>
  </tbody>
</table>

<div class="section-title">9.3 Code Root Cause in lib/copilot/investigation/plan.ts</div>
<div class="card">
  <div class="card-title"><span>expandLegs Flawed Assumption (commit 9232cc9b)</span><span class="fail-tag">CODE DEFECT</span></div>
  <p>In commit <code>9232cc9b</code> (13 Sep), <code>expandLegs()</code> was modified to rewrite any repay leg:</p>
  <div style="background: #f8fafc; border: 1px solid #cbd5e1; padding: 5px 8px; font-family: monospace; font-size: 9px; margin-bottom: 4px;">
    return legs.flatMap((leg): SizerLeg[] =&gt; leg.op === "repay" &amp;&amp; (leg.sizing.kind === "all_idle" || leg.sizing.kind === "all_position")<br>
    &nbsp;&nbsp;? [&#123; op: "deposit_collateral", asset: leg.asset, sizing: &#123; kind: "all_idle" &#125;, fundsRepay: true &#125;, &#123; op: "repay", asset: leg.asset, sizing: &#123; kind: "previous_leg" &#125; &#125;]<br>
    &nbsp;&nbsp;: [leg]);
  </div>
  <p>
    <strong>Flawed Assumption:</strong> The author assumed that EVERY debt repayment must be funded by depositing idle tokens from the user's external wallet. When the sizer evaluated the injected <code>deposit_collateral</code> leg, it looked up <code>holdings["BLUSDC"]</code> (the wallet), saw 0, and threw <code>Reject</code>:
    <em>"you owe 186.7342581 BLUSDC and the wallet holds no spendable BLUSDC — add 186.7342581 BLUSDC to the wallet, or redeem it from Earn first"</em>.
    This blocked a 100% executable and solvent operation in Incidents 4, 5, and 6!
  </p>
</div>

<div class="footer-note">
  <span>Vanna Copilot QA & Audit Suite · Master Document</span>
  <span>Page 10 of 11</span>
</div>

<!-- ================= PAGE 11: PIPELINE RCA & PRODUCTION REMEDIATION ================= -->
<div class="page-break"></div>

<div class="header-bar">
  <div>
    <div class="logo-title">ARCHITECTURAL ROOT CAUSE & PRODUCTION REMEDIATION</div>
    <div class="logo-subtitle">Code Tracing Across Orchestrator Pipeline & Actionable Engineering Fixes</div>
  </div>
  <div><span class="pass-tag">ACTIONABLE REMEDIATION SPEC</span></div>
</div>

<div class="section-title">10.1 Code-Level Tracing Across lib/copilot/</div>
<ul>
  <li>
    <strong>Unit Parser Multipliers (<code>lib/copilot/investigation/quantities.ts</code>):</strong>
    <code>quantitySpans</code> only matches raw digits and ignores unit multipliers like <code>k</code> and <code>m</code>. When <code>isTokenAmountIn</code> executes <code>text.includes(amount)</code>, it fails to match <code>"5k"</code> to <code>"5000"</code>, causing requested actions to throw <code>unanchored_amount</code>.
  </li>
  <li>
    <strong>Silent Error Catch (<code>lib/copilot/investigation/requested-actions.ts</code>):</strong>
    In <code>compileRequestedActions</code>, any parsing error is caught silently with <code>catch {{ return []; }}</code>, leaving the user with an empty step array and no explanatory feedback.
  </li>
  <li>
    <strong>Read Aggregation Leak (<code>lib/copilot/investigation/facts-by-shape.ts</code>):</strong>
    The facts extractor and research synthesis loop conflated the account's total token balance or added the borrowed liability back into the collateral asset entry, generating the false claim that 139.39 XLM was posted collateral.
  </li>
  <li>
    <strong>UI Objective Leakage (<code>lib/copilot/investigation/service.ts</code>):</strong>
    When <code>candidates</code> evaluates to <code>null</code> and <code>earlySteps</code> is empty, <code>service.ts</code> renders <code>outcome.goal.objective</code> as the card title without providing an interactive question or solution.
  </li>
  <li>
    <strong>Repayment Wallet Ingestion Fallacy (<code>lib/copilot/investigation/plan.ts:expandLegs</code>):</strong>
    In commit <code>9232cc9b</code>, <code>expandLegs</code> unconditionally forced <code>all_position</code> repay legs to be preceded by a wallet <code>deposit_collateral</code> leg with <code>all_idle</code> sizing. This crashed on any account holding sufficient margin balance to repay directly if their external wallet held 0 tokens.
  </li>
  <li>
    <strong>Blend Liquidity Removal Boundary (<code>lib/copilot/workflow/types.ts</code> &amp; <code>allowlist.ts</code>):</strong>
    <code>WORKFLOW_OPS</code> and <code>TOOLS</code> omit <code>withdraw_from_blend</code> / <code>unsupply_blend</code>, leaving the copilot unable to compile liquidity removal from Blend despite on-chain support, deadlocking on <code>[Start over]</code> without linking to <code>/farm</code>.
  </li>
</ul>

<div class="section-title">10.2 Institutional Production Remediation Plan (Never Hardcode)</div>
<div class="card">
  <div class="card-title"><span>Required Code Fixes</span><span class="pass-tag">FIX ROADMAP</span></div>
  <ul>
    <li>
      <strong>Fix 1: Native Smart Account Repayment from Margin Account Balance (Resolves Incidents 4, 5, and 6):</strong>
      In <code>lib/copilot/investigation/plan.ts</code>, decouple <code>all_position</code> repay from mandatory wallet deposits. Allow <code>vanna_repay</code> to execute directly using the margin smart account's internal token balance. Only inject a wallet <code>deposit_collateral</code> leg when the account has a verified funding deficit: <code>max(0, debt - margin_balance)</code>. This single generalized fix resolves Incidents 4, 5, and 6 for any token or debt amount without hardcoded rules.
    </li>
    <li>
      <strong>Fix 2: First-Class Blend Liquidity Removal &amp; Interactive UI Deep-Link (Resolves Incident 7):</strong>
      Add <code>withdraw_from_blend</code> to <code>WORKFLOW_OPS</code> and map it to <code>vanna_blend_withdraw</code> in <code>allowlist.ts</code>. In <code>flash.ts</code> and <code>requested-actions.ts</code>, compile Blend unsupplies verified against <code>BlendService.getPoolUserPosition</code>. Whenever an unsupported operation is encountered, never deadlock on <code>[Start over]</code>: render an interactive navigation button (e.g. <code>[Open Farm Page (/farm)]</code>) with step-by-step guidance.
    </li>
    <li>
      <strong>Fix 3: Metric Multiplier Support in quantities.ts (Resolves Incident 2):</strong>
      Update <code>quantities.ts</code> to parse standard financial multipliers (<code>k</code> = &times; 10<sup>3</sup>, <code>m</code> = &times; 10<sup>6</sup>, <code>b</code> = &times; 10<sup>9</sup>). In <code>isTokenAmountIn</code>, evaluate numeric equivalence after multiplier expansion rather than strict substring containment.
    </li>
    <li>
      <strong>Fix 4: Deterministic Collateral Ceiling (Resolves Incident 3):</strong>
      Enforce the invariant formula in <code>facts-by-shape.ts</code> and <code>handle-read.ts</code>:
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 3px 6px; margin: 2px 0; font-family: monospace; font-size: 10px;">
        withdrawable = min(posted_collateral, max_withdrawable_at_hf_floor)
      </div>
      Never sum borrowed debt with collateral assets. The withdrawable ceiling for XLM on this account is strictly <strong>70.91 XLM</strong>.
    </li>
    <li>
      <strong>Fix 5: Multi-Bucket Read Fan-Out &amp; Disambiguation (Resolves Incident 1):</strong>
      Any withdrawal or balance query must fan out parallel reads across Spendable Wallet, Margin Collateral, and Earn Pools. When a user states a circular request, present an active clarification dialogue with clear options.
    </li>
    <li>
      <strong>Fix 6: Transparent Error Feedback:</strong>
      Replace silent <code>try/catch</code> blocks in <code>compileRequestedActions</code> with detailed warnings on the card, preventing empty terminal screens with only <code>[Start over]</code>.
    </li>
  </ul>
</div>

<div class="footer-note">
  <span>Vanna Copilot QA & Audit Suite · Master Document</span>
  <span>Page 11 of 11 · Document Generated: September 14, 2026</span>
</div>

</body>
</html>
"""

temp_html = Path("temp_unified_report.html")
temp_html.write_text(html, encoding="utf-8")

p = sync_playwright().start()
b = p.chromium.launch()
pg = b.new_page()
pg.set_content(html, wait_until="networkidle")
pg.pdf(
    path=str(DESKTOP_PDF),
    format="A4",
    print_background=True,
    margin={"top": "10mm", "bottom": "10mm", "left": "10mm", "right": "10mm"}
)
b.close()
p.stop()
if temp_html.exists():
    temp_html.unlink()

print("Unified PDF successfully generated at:", DESKTOP_PDF)
print("File size (bytes):", DESKTOP_PDF.stat().st_size)
