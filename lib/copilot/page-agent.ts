/**
 * Page-aware agent (Gemini plan): structured pageContext + client tool calling.
 * System prompt follows the master assistant plan from Gemini.
 */

import type { ChatResponse, SemanticPageContextCtx } from "./types";
import { generateText, generateWithClientTools, VertexError } from "./vertex";
import { isAssistantChat } from "./concept";

export { isAssistantChat };

/** Plan Section 2 — system prompt (stable for cache). */
export const PAGE_AGENT_SYSTEM = `You are an intelligent, page-aware AI Copilot for Vanna Finance (Stellar DeFi).
Help users understand what they see and how to use the product.

CRITICAL — ALWAYS ANSWER IN TEXT:
- Every reply MUST include a full natural-language answer the user can read.
- NEVER respond with tools only. Tools are optional extras, never a substitute for an explanation.
- Questions like "what is X", "what can X do", "how do I…", "explain…" → answer fully in prose first.
  Do NOT call tools for pure explanation questions.

### pageContext (sent as JSON each turn)
path, title, sections (headings + DOM ids), mainText, selectedText, interactiveHints.

### Tools (only when the user wants to be shown or taken somewhere)
- scrollToSection: they ask where something is ON THIS page / "show me that section".
- navigateToRoute: they ask to GO to another page ("open earn", "take me to farm").
- highlightElement: they ask where to click a specific control.
Known paths: /, /margin, /earn, /earn/XLM, /farm, /portfolio, /trade/spot, /copilot, /analytics...

### Rules
1. If selectedText is set, treat the question as about that highlight unless they say otherwise.
2. Ground answers in mainText / selectedText / sections. Do not invent balances, APYs, or UI that is not present.
3. Product knowledge for Vanna: margin = deposit collateral / borrow / health factor (~1.1 liq); earn = supply to vaults; farm = Blend / Aquarius / Soroswap LP; spot = swap. BLUSDC, AQUSDC, SOUSDC are different USDC tokens.
4. "Leverage your assets" / leveraged strategies usually means using margin (collateral + borrow) or farm leverage paths — explain using page text when available, else general Vanna product language without fake numbers.
5. Formatting: plain prose, no ** markdown stars, no # headings, no code fences. Use "1. " for steps.
6. Never claim you signed or submitted a transaction.

When you use a tool, still write the full answer in the same turn (e.g. explain the feature AND scroll).`;

/** Text-only follow-up when the model returned tools without prose. */
const ANSWER_ONLY_SYSTEM = `You are Vanna’s page-aware assistant. Answer the user fully in plain prose.
Use the pageContext JSON. No tools. No ** markdown. No code fences.
Explain what they asked and how to do it on Vanna when relevant. Be concrete and helpful.`;

/** Vertex function declarations for client-side tools (plan Section 1.2). */
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
      "Smooth-scroll to a section on the current page by DOM element id (from pageContext.sections). Optionally pulse-highlight it.",
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
      "Highlight an interactive UI element using a CSS selector or data-copilot-id value from interactiveHints.",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description:
            "CSS selector or data-copilot-id value, e.g. [data-copilot-id='swap-button'] or #deposit",
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
    .trim();
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
          // Cap mainText in the prompt body
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

  const user = [
    "pageContext JSON:",
    ctxJson,
    "",
    historyBlock,
    `USER: ${message}`,
  ]
    .filter(Boolean)
    .join("\n");

  // Pure how/what questions should not waste a turn on tool-only replies
  const wantsGuidanceOnly =
    /\b(what is|what are|what can|what does|how (?:do|does|can|to)|explain|tell me|meaning|kya |kaise )\b/i.test(
      message,
    ) && !/\b(show me|take me|go to|open |scroll|where (?:is|do i click|on (?:this|the) page))\b/i.test(message);

  try {
    let text = "";
    let client_tools: Array<{ name: string; args: Record<string, unknown> }> = [];

    if (wantsGuidanceOnly) {
      // Explanation path: always full prose, no tools
      text = await generateText(ANSWER_ONLY_SYSTEM, user, { temperature: 0.45 });
    } else {
      const result = await generateWithClientTools(
        PAGE_AGENT_SYSTEM,
        user,
        CLIENT_TOOL_DECLS as any,
      );
      text = result.text;
      client_tools = result.client_tools;
      // Model returned tools with no answer → second pass for real prose
      if (!text.trim()) {
        text = await generateText(ANSWER_ONLY_SYSTEM, user, { temperature: 0.45 });
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
    // Last resort: plain text without tools
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
    } catch {
      return {
        kind: "answer",
        message: "I could not reach the assistant model just now. Try again in a moment.",
        data: {
          assistant: true,
          offline: true,
          error: String(e instanceof Error ? e.message : e),
        },
        client_tools: [],
        intent: { template_id: "page_assist", slots: { mode: "unavailable" } },
        request_id,
      };
    }
  }
}
