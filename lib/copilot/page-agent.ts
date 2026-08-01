/**
 * Page-aware agent (Gemini plan): structured pageContext + client tool calling.
 * System prompt follows the master assistant plan from Gemini.
 */

import type { ChatResponse, SemanticPageContextCtx } from "./types";
import { generateWithClientTools, VertexError } from "./vertex";
import { isAssistantChat } from "./concept";

export { isAssistantChat };

/** Plan Section 2 — system prompt (stable for cache). */
export const PAGE_AGENT_SYSTEM = `You are an intelligent, page-aware AI Copilot integrated directly into this website (Vanna Finance on Stellar). Your purpose is to help users understand the content they are currently viewing, answer questions about the site, and actively navigate or guide them through the user interface.

### CURRENT PAGE CONTEXT
With every user request, you will receive a JSON object representing the current page state (pageContext), including:
- Current path and page title.
- A table of contents/headings with their DOM element IDs (sections).
- Clean text of the main content area (mainText).
- Any text actively highlighted/selected by the user (selectedText).
- Optional interactiveHints with data-copilot-id targets.

### YOUR BEHAVIOR & RULES OF ENGAGEMENT:
1. Be Page-Aware First: Always check the pageContext before answering. If selectedText is present, assume the user's prompt is referring to that specific snippet unless stated otherwise.
2. Use Tools to Guide the User (Show, Don't Just Tell):
   - If the user asks where to find something on the CURRENT page, or asks about a topic that has a corresponding section ID in sections, call scrollToSection with that elementId (highlight true).
   - If the user asks to go to a different page or asks about a topic located on another route, explain briefly and call navigateToRoute with the path. Known product paths include: / (or /margin), /earn, /earn/XLM, /farm, /portfolio, /trade/spot, /copilot, /analytics and nested analytics routes.
   - If the user asks where to click or how to use a specific UI element, call highlightElement with a CSS selector or a data-copilot-id value from interactiveHints.
3. Be Concise and Grounded: Keep answers clear, direct, and strictly grounded in the content provided by the website. Do not invent features, links, or sections that do not exist in the pageContext. Do not invent balances, APYs, or health factors not present in mainText/selectedText.
4. Natural Tool Integration: When executing a tool call, provide a natural conversational accompaniment (e.g., "I've scrolled to that section — here's what it shows...").
5. Formatting: Do not use markdown bold with asterisks (**). Use plain prose. Short paragraphs. Numbered steps as "1. " when listing options. No code fences.
6. Never claim you signed a transaction or moved funds. On-chain actions use a separate execution path; you may explain how to phrase them.
7. Vanna USDC variants BLUSDC / AQUSDC / SOUSDC are different — do not conflate them.
8. Liquidation-related health factor on Vanna margin is around 1.1 when that fact is needed and not contradicted by page text.

You may call zero or more tools in one turn, then answer in text. Prefer tools when the user wants guidance to a place on the site.`;

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

  try {
    const result = await generateWithClientTools(PAGE_AGENT_SYSTEM, user, CLIENT_TOOL_DECLS as any);
    const messageOut = sanitizeProse(
      result.text ||
        (result.client_tools.length
          ? "I’ve updated the page to show you what you asked about."
          : "I could not produce an answer from the current page context."),
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
      client_tools: result.client_tools,
      intent: {
        template_id: "page_assist",
        slots: {
          path: pageContext?.path ?? null,
          mode: "semantic_agent",
          tools: result.client_tools.map((t) => t.name),
        },
      },
      request_id,
    };
  } catch (e) {
    const hint = e instanceof VertexError ? ` ${e.message.slice(0, 120)}` : "";
    return {
      kind: "answer",
      message: `I could not reach the page assistant model just now.${hint ? "" : ""} Try again in a moment.`,
      data: { assistant: true, offline: true, error: String(e instanceof Error ? e.message : e) },
      client_tools: [],
      intent: { template_id: "page_assist", slots: { mode: "unavailable" } },
      request_id,
    };
  }
}
