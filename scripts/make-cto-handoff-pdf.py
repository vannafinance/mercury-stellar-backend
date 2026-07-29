"""Generate CTO handoff PDF for Vanna Copilot / MCP fixes."""
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

out = r"C:\Users\akgam\Desktop\Vanna_Copilot_CTO_Handoff_MCP_Fixes_2026-07-30.pdf"
doc = SimpleDocTemplate(
    out,
    pagesize=letter,
    leftMargin=0.75 * inch,
    rightMargin=0.75 * inch,
    topMargin=0.7 * inch,
    bottomMargin=0.7 * inch,
)
styles = getSampleStyleSheet()
title = ParagraphStyle("T", parent=styles["Title"], fontSize=16, spaceAfter=8)
h1 = ParagraphStyle(
    "H1",
    parent=styles["Heading1"],
    fontSize=13,
    spaceBefore=14,
    spaceAfter=6,
    textColor=colors.HexColor("#1a1a2e"),
)
h2 = ParagraphStyle(
    "H2",
    parent=styles["Heading2"],
    fontSize=11,
    spaceBefore=10,
    spaceAfter=4,
    textColor=colors.HexColor("#2d2d44"),
)
body = ParagraphStyle("B", parent=styles["BodyText"], fontSize=9.5, leading=13, spaceAfter=4)
mono = ParagraphStyle(
    "M",
    parent=styles["Code"],
    fontSize=8,
    leading=11,
    backColor=colors.HexColor("#f4f4f8"),
    spaceBefore=4,
    spaceAfter=6,
)
small = ParagraphStyle(
    "S", parent=styles["BodyText"], fontSize=8.5, leading=11, textColor=colors.HexColor("#444")
)
bullet = ParagraphStyle(
    "Bu", parent=styles["BodyText"], fontSize=9.5, leading=12, leftIndent=12, spaceAfter=2
)

story = []
story.append(Paragraph("Vanna Copilot — CTO / Peer Handoff", title))
story.append(
    Paragraph(
        "MCP-side fixes needed · Copilot status · Sanujit prompt matrix",
        styles["Heading3"],
    )
)
story.append(
    Paragraph(
        "<b>Date:</b> 2026-07-30 &nbsp;|&nbsp; <b>Branch:</b> "
        "<font face='Courier'>vanna-copilot</font> @ GitHub vannafinance/mercury-stellar-backend "
        "&nbsp;|&nbsp; <b>Network:</b> Stellar Testnet",
        small,
    )
)
story.append(
    Paragraph(
        "<b>Audience:</b> CTO / MCP owner / peer reviewer &nbsp;|&nbsp; "
        "<b>App:</b> Next.js in-process brain (Vertex + live MCP)",
        small,
    )
)
story.append(Spacer(1, 8))

story.append(Paragraph("1. Executive summary", h1))
story.append(
    Paragraph(
        "Copilot is wired as an agent-native UI: Vertex Gemini parses intent, the live Vanna MCP "
        "server executes reads/builds writes, and the user wallet signs unsigned XDR. Several Sanujit "
        "Farm/Earn prompts are fixed on the <b>copilot (app) side</b>. Critical Farm write paths "
        "fail inside MCP simulation with clear packing bugs — those need <b>MCP server</b> fixes before "
        "end-to-end farm supply works.",
        body,
    )
)

story.append(Paragraph("2. What works on copilot (ready to demo)", h1))
rows = [
    [
        Paragraph("<b>Area</b>", body),
        Paragraph("<b>Status</b>", body),
        Paragraph("<b>Notes</b>", body),
    ],
    [
        Paragraph("In-process brain", body),
        Paragraph("DONE", body),
        Paragraph("npm run dev only; /api/copilot → Vertex + MCP", body),
    ],
    [
        Paragraph("Earn lend valid amounts", body),
        Paragraph("DONE", body),
        Paragraph("vanna_lend XDR + Approve &amp; sign", body),
    ],
    [
        Paragraph("Earn over-balance / dust / DOGE", body),
        Paragraph("DONE", body),
        Paragraph("Preflight block; no raw Contract #3 dump", body),
    ],
    [
        Paragraph("Missing amount + APY", body),
        Paragraph("DONE", body),
        Paragraph("“earn yield on XLM” asks amount + live APY", body),
    ],
    [
        Paragraph("Highest-yielding pool supply", body),
        Paragraph("APP FIXED", body),
        Paragraph("Ranks 4 earn pools, names winner, then lend preview", body),
    ],
    [
        Paragraph("Aquarius list I can farm", body),
        Paragraph("PASS", body),
        Paragraph("Exactly 3: XLM/USDC, XLM/AQUA, XLM/USDT", body),
    ],
    [
        Paragraph("Blend supply routing", body),
        Paragraph("APP FIXED", body),
        Paragraph("deploy_to_blend (not deposit_collateral)", body),
    ],
    [
        Paragraph("Deposit→borrow 2×/3× chain", body),
        Paragraph("DONE", body),
        Paragraph("Sequential steps + auto-chain after sign", body),
    ],
    [
        Paragraph("Right-rail HF/collateral/debt", body),
        Paragraph("DONE", body),
        Paragraph("Same snapshot as margin/portfolio", body),
    ],
]
t = Table(rows, colWidths=[1.6 * inch, 0.9 * inch, 4.0 * inch])
t.setStyle(
    TableStyle(
        [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8e8f0")),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cccccc")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]
    )
)
story.append(t)

story.append(Paragraph("3. MCP-side fixes required (priority)", h1))
story.append(
    Paragraph(
        "These fail even when copilot passes correct human-readable args. Fix on "
        "<b>mcp.vanna.finance / vanna-mcp-server</b>, not only the website.",
        body,
    )
)

story.append(Paragraph("P0 — vanna_deploy_to_blend packs Blend Deposit amount = 0", h2))
story.append(
    Paragraph(
        "<b>Prompt:</b> “Supply 10 XLM to Blend” (Sanujit FW1)<br/>"
        "<b>Symptom:</b> HostError Contract #1216. Event log shows wallet→margin deposit of 10 XLM succeeds, "
        "but <font face='Courier'>execute_direct</font> to Blend is "
        "<font face='Courier'>[Deposit], … [XLM], [0], 0</font> — zero amount into Blend.<br/>"
        "<b>Copilot args sent:</b> deposit_amount=\"10\", borrow_amount=\"0\", token_symbol=\"XLM\", "
        "blend_tokens_in=[\"XLM\"], blend_amounts_in=[\"10\"], blend_pool_address=Registry blend pool.<br/>"
        "<b>Ask:</b> Fix ExternalProtocolCall / amount_in packing so human “10” becomes correct WAD "
        "for Blend submit (or document required scale). Add unit test for plain supply (borrow=0).<br/>"
        "<b>Acceptance:</b> Simulation returns unsigned_xdr + simulation_success=true for 10 XLM supply "
        "with funded wallet + margin account.",
        body,
    )
)

story.append(Paragraph("P1 — Earn / Farm intent boundaries in MCP docs &amp; tooling", h2))
story.append(
    Paragraph(
        "Agents often confuse Vanna Earn (<font face='Courier'>vanna_lend</font> / pool_stats) with Blend "
        "(<font face='Courier'>vanna_get_blend_*</font> / deploy). Keep tool descriptions explicit: "
        "Earn = G-wallet vTokens; Farm Blend/Aquarius = C smart account. Copilot overrides many cases "
        "in app code; MCP descriptions should match to reduce LLM mistakes.",
        body,
    )
)

story.append(Paragraph("P2 — Simulation errors should be structured", h2))
story.append(
    Paragraph(
        "Today write tools return huge HostError event dumps. Prefer structured errors, e.g. "
        "<font face='Courier'>{error, code, reason, amount_requested, amount_seen, balance}</font> "
        "so clients can show one clean line (copilot already humanizes #3 and #1216 partially).",
        body,
    )
)

story.append(Paragraph("P3 — Aquarius list: optional filter for Vanna farm pairs", h2))
story.append(
    Paragraph(
        "Copilot filters API’s 50 pools to XLM/USDC, XLM/AQUA, XLM/USDT. Optional MCP flag "
        "<font face='Courier'>vanna_list_aquarius_pools(scope=\"vanna_farm\")</font> would align "
        "server with product.",
        body,
    )
)

story.append(Paragraph("P4 — Simple Blend supply without deposit_borrow_and_deploy", h2))
story.append(
    Paragraph(
        "Product PDF FW1 is “supply from margin account to Blend reserve”, not always "
        "deposit+borrow+deploy. If website uses AccountManager.execute Deposit-only, expose a matching "
        "MCP tool (e.g. <font face='Courier'>vanna_blend_supply</font>) so agents don’t misuse "
        "leverage entrypoint.",
        body,
    )
)

story.append(Paragraph("4. Live repro (test wallet)", h1))
story.append(
    Paragraph(
        "Trader G: <font face='Courier'>GD4BQRQPYLVM7YS57V4USR265UFZFEXIVDJJBIK3BAFQJ3F6SCA5NPDH</font><br/>"
        "Smart C: <font face='Courier'>CDQK6I6LTCWPNQNFFFE74U2QJWM6SBCD5H2XC22VDZMQM3GGPH47IA6U</font><br/>"
        "Blend pool (Registry): <font face='Courier'>CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF</font>",
        mono,
    )
)

story.append(Paragraph("5. Sanujit prompt status (high level)", h1))
rows2 = [
    [
        Paragraph("<b>ID</b>", body),
        Paragraph("<b>Status</b>", body),
        Paragraph("<b>Owner</b>", body),
    ],
    [
        Paragraph("E1–E5, E8, E21–E25 earn reads", body),
        Paragraph("Mostly PASS", body),
        Paragraph("OK", body),
    ],
    [
        Paragraph("EW1–EW3, EW5–EW6, EW8–EW10 earn writes", body),
        Paragraph("PASS / app-fixed", body),
        Paragraph("OK", body),
    ],
    [
        Paragraph("EW5 highest-yielding", body),
        Paragraph("App ranks + stages lend", body),
        Paragraph("OK (verify UI after latest commit)", body),
    ],
    [
        Paragraph("F9 Aquarius list", body),
        Paragraph("PASS (3 pools)", body),
        Paragraph("OK", body),
    ],
    [
        Paragraph("FW1 Supply to Blend", body),
        Paragraph("Route OK; sim FAIL #1216 amount=0", body),
        Paragraph("<b>MCP</b>", body),
    ],
    [
        Paragraph("FW2–FW17 farm writes", body),
        Paragraph("PARTIAL / not fully mapped", body),
        Paragraph("MCP + app", body),
    ],
    [
        Paragraph("X1–X6, A1–A15", body),
        Paragraph("Mixed", body),
        Paragraph("app polish", body),
    ],
]
t2 = Table(rows2, colWidths=[2.2 * inch, 2.4 * inch, 1.9 * inch])
t2.setStyle(
    TableStyle(
        [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8e8f0")),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cccccc")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]
    )
)
story.append(t2)

story.append(Paragraph("6. How to review the app branch", h1))
story.append(
    Paragraph(
        "git fetch origin &amp;&amp; git checkout vanna-copilot<br/>"
        "npm install &amp;&amp; npm run dev<br/>"
        "Open /copilot with wallet connected. Demo: USDC earn APY → highest-yielding supply → "
        "Aquarius list → Supply 10 XLM to Blend (expect clear MCP #1216 note until server fix).",
        mono,
    )
)

story.append(Paragraph("7. Point summary for the meeting", h1))
points = [
    "Copilot = Vertex intent + live MCP + wallet sign; single Next process.",
    "Earn path is solid: balance preflight, XDR preview, auto-approve optional.",
    "Highest-yield supply ranks pools and names the winner before lend.",
    "Aquarius farmable list is exactly three pairs (PDF F9).",
    "Blend supply is correctly routed to deploy_to_blend (was deposit_collateral).",
    "Blend still fails MCP sim: Deposit amount packed as 0 → Contract #1216 — MCP fix needed.",
    "Deposit→borrow sequential agent works; right rail tracks margin HF.",
    "Branch vanna-copilot pushed for peer/CTO review.",
    "Next: MCP blend amount packing + optional blend_supply tool; then retest FW*.",
    "Full narrative also on Desktop: Vanna_Copilot_Meeting_Report_2026-07-30.md",
]
for i, p in enumerate(points, 1):
    story.append(Paragraph(f"{i}. {p}", bullet))

story.append(Spacer(1, 12))
story.append(
    Paragraph(
        "Contact context: copilot app work on branch vanna-copilot. MCP ownership required for "
        "P0 blend packing. Please confirm once #1216 zero-amount deploy is fixed so we can "
        "re-run Sanujit farm write suite.",
        small,
    )
)

doc.build(story)
print("Wrote", out)
