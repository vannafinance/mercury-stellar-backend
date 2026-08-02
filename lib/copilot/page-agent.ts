/**
 * Page-aware agent (Gemini plan): structured pageContext + client tool calling.
 */

import type { ChatResponse, SemanticPageContextCtx } from "./types";
import { generateText, generateWithClientTools, VertexError } from "./vertex";
import { isAssistantChat } from "./concept";
import { DOMAIN_FIREWALL_SYSTEM } from "./domain-firewall";

export { isAssistantChat };

/** Shared formatting contract so every answer looks like a clean AI reply. */
const FORMAT_RULES = `
### OUTPUT FORMAT (required — the UI renders this with spacing and bullets)
Structure every answer like a modern AI assistant:

1) Open with 1–2 short sentences that answer the question directly.
2) Blank line.
3) If you list options or concepts, use a section title on its own line, then bullets:
   What it means
   • Point one
   • Point two
4) Blank line before steps. For how-to, use a section title then numbered steps:
   How to do it
   1. First action — brief detail.
   2. Second action — brief detail.
   3. Third action — brief detail.
5) Optional closing tip on its own line after a blank line (no section needed).

Hard rules:
- Put a blank line between the intro, each section, and the steps.
- One idea per bullet or step. Keep steps short.
- Use "• " for bullets (bullet character) and "1. " "2. " for steps — never walls of paragraphs.
- Do NOT use **bold**, *italic*, markdown # headings, or code fences.
- Do NOT write First,/Second,/Third, as prose — always use numbered "1. 2. 3." instead.
- No fake numbers. Only cite balances/APYs if they appear in pageContext.
`;

export const PAGE_AGENT_SYSTEM = `You are an intelligent, page-aware AI Copilot for Vanna Finance (Stellar DeFi).
Help users understand what they see and how to use the product.
${DOMAIN_FIREWALL_SYSTEM}

CRITICAL — ALWAYS ANSWER IN TEXT:
- Every reply MUST include a full natural-language answer.
- NEVER respond with tools only.
- Pure explain questions (what is / what can / how do I) → full structured answer, no tools.

### pageContext (JSON each turn)
path, title, sections, mainText, selectedText, interactiveHints.

### Tools (only for show me / take me / where do I click)
- scrollToSection, navigateToRoute, highlightElement
Paths: /, /margin, /earn, /farm, /portfolio, /trade/spot, /copilot, /analytics...

### Product notes
Margin: deposit collateral, borrow, health factor (~1.1 liquidation). Earn: supply vaults.
Farm: Blend / Aquarius / Soroswap. Spot: swap. BLUSDC / AQUSDC / SOUSDC are different.
Leverage: deposit collateral + borrow (and related farm leverage) — explain from page text when present.
Never claim you signed a transaction.
${FORMAT_RULES}`;

const ANSWER_ONLY_SYSTEM = `You are Vanna’s page-aware assistant. Answer fully using pageContext when useful.
No tools. Be concrete and helpful about Vanna (margin, earn, farm, spot).
${DOMAIN_FIREWALL_SYSTEM}
${FORMAT_RULES}`;

/** Vertex function declarations for client-side tools. */
export const CLIENT_TOOL_DECLS = [
  {
    name: "navigateToRoute",
    description:
      "Navigate the user to another in-app route without a full page reload (SPA navigation).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "App path, e.g. /earn, /farm, /portfolio, /trade/spot, /analytics",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "scrollToSection",
    description:
      "Smooth-scroll to a section on the current page by DOM element id (from pageContext.sections).",
    parameters: {
      type: "object",
      properties: {
        elementId: {
          type: "string",
          description: "DOM id of the heading/section (from sections[].id)",
        },
        highlight: {
          type: "boolean",
          description: "Whether to apply visual highlight pulse (default true)",
        },
      },
      required: ["elementId"],
    },
  },
  {
    name: "highlightElement",
    description:
      "Highlight an interactive UI element using a CSS selector or data-copilot-id value.",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector or data-copilot-id value",
        },
      },
      required: ["selector"],
    },
  },
] as const;

function sanitizeProse(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/```[\s\S]*?```/g, (b) => b.replace(/```\w*\n?/g, "").replace(/```/g, ""))
    // Normalize First,/Second, prose into numbered steps when model slips
    .replace(/^(First|Second|Third|Fourth|Fifth|Finally),?\s+/gim, (_m, w) => {
      const map: Record<string, string> = {
        first: "1. ",
        second: "2. ",
        third: "3. ",
        fourth: "4. ",
        fifth: "5. ",
        finally: "6. ",
      };
      return map[String(w).toLowerCase()] || "• ";
    })
    .trim();
}

/**
 * Offline answer from pageContext when Vertex is down — still answers
 * “what is on my screen” without inventing numbers.
 */
function offlineScreenAnswer(pageContext: SemanticPageContextCtx | null): string {
  if (!pageContext) {
    return (
      "I cannot reach the AI model right now, and I did not receive a page snapshot from your browser.\n\n" +
      "How to fix\n" +
      "1. Confirm you are logged into Google Cloud (gcloud auth login) for Vertex.\n" +
      "2. Refresh the page and open Ask again.\n" +
      "3. Retry your question."
    );
  }
  const path = pageContext.path || pageContext.url || "this page";
  const title = pageContext.title || "Untitled";
  const sections = (pageContext.sections || [])
    .map((s) => s.text)
    .filter(Boolean)
    .slice(0, 12);
  const main = String(pageContext.mainText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
  const selected = pageContext.selectedText?.trim();

  const lines: string[] = [
    `You are on ${title} (${path}). I am answering from the live page text because the model was temporarily unreachable.`,
    "",
  ];
  if (selected) {
    lines.push("Selected text");
    lines.push(`• ${selected.slice(0, 400)}`);
    lines.push("");
  }
  if (sections.length) {
    lines.push("Sections visible");
    for (const s of sections) lines.push(`• ${s}`);
    lines.push("");
  }
  if (main) {
    lines.push("On-screen text (excerpt)");
    lines.push(`• ${main}${main.length >= 900 ? "…" : ""}`);
    lines.push("");
  }
  lines.push(
    "Tip: once Vertex is reachable again, ask the same question for a fuller structured answer.",
  );
  return lines.join("\n");
}

export async function runPageAgent(
  message: string,
  pageContext: SemanticPageContextCtx | null,
  request_id: string,
  history?: Array<{ role: "user" | "assistant"; text: string }>,
): Promise<ChatResponse> {
  const ctxJson = pageContext
    ? JSON.stringify(
        {
          url: pageContext.url,
          path: pageContext.path,
          title: pageContext.title,
          description: pageContext.description,
          sections: pageContext.sections,
          selectedText: pageContext.selectedText,
          interactiveHints: pageContext.interactiveHints,
          mainText: String(pageContext.mainText || "").slice(0, 10_000),
        },
        null,
        2,
      )
    : JSON.stringify({ error: "no pageContext provided" });

  const historyBlock =
    history && history.length
      ? [
          "RECENT CONVERSATION:",
          ...history.slice(-8).map((t) => `${t.role}: ${t.text.slice(0, 1200)}`),
          "",
        ].join("\n")
      : "";

  const user = ["pageContext JSON:", ctxJson, "", historyBlock, `USER: ${message}`]
    .filter(Boolean)
    .join("\n");

  const wantsGuidanceOnly =
    /\b(what is|what are|what can|what does|how (?:do|does|can|to)|explain|tell me|meaning|kya |kaise )\b/i.test(
      message,
    ) &&
    !/\b(show me|take me|go to|open |scroll|where (?:is|do i click|on (?:this|the) page))\b/i.test(
      message,
    );

  try {
    let text = "";
    let client_tools: Array<{ name: string; args: Record<string, unknown> }> = [];

    if (wantsGuidanceOnly) {
      text = await generateText(ANSWER_ONLY_SYSTEM, user, { temperature: 0.4 });
    } else {
      const result = await generateWithClientTools(
        PAGE_AGENT_SYSTEM,
        user,
        CLIENT_TOOL_DECLS as any,
      );
      text = result.text;
      client_tools = result.client_tools;
      if (!text.trim()) {
        text = await generateText(ANSWER_ONLY_SYSTEM, user, { temperature: 0.4 });
      }
    }

    const messageOut = sanitizeProse(
      text.trim() ||
        "I could not produce an answer from the current page. Try rephrasing your question.",
    );

    return {
      kind: "answer",
      message: messageOut,
      data: {
        assistant: true,
        page_path: pageContext?.path ?? null,
        used_semantic_context: Boolean(pageContext),
        selected: Boolean(pageContext?.selectedText),
        model: "vertex",
      },
      client_tools,
      intent: {
        template_id: "page_assist",
        slots: {
          path: pageContext?.path ?? null,
          mode: wantsGuidanceOnly ? "explain" : "semantic_agent",
          tools: client_tools.map((t) => t.name),
        },
      },
      request_id,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.warn("[copilot:page-agent] primary failed:", errMsg.slice(0, 200));
    try {
      const fallback = await generateText(ANSWER_ONLY_SYSTEM, user, { temperature: 0.4 });
      return {
        kind: "answer",
        message: sanitizeProse(fallback),
        data: { assistant: true, fallback: true },
        client_tools: [],
        intent: { template_id: "page_assist", slots: { mode: "fallback_text" } },
        request_id,
      };
    } catch (e2) {
      // Still answer screen questions from DOM — never dead-end on Vertex outage.
      const offline = offlineScreenAnswer(pageContext);
      return {
        kind: "answer",
        message: sanitizeProse(offline),
        data: {
          assistant: true,
          offline: true,
          error: String(e2 instanceof Error ? e2.message : e2),
          primary_error: errMsg.slice(0, 300),
        },
        client_tools: [],
        intent: { template_id: "page_assist", slots: { mode: "offline_dom" } },
        request_id,
      };
    }
  }
}
