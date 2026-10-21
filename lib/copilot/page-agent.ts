/**
 * Page-aware agent: single-pass structured Guide response + in-schema client tool calling.
 */

import type {
  ChatResponse,
  SemanticPageContextCtx,
  PageSnapshotCtx,
  AssistantSessionEvent,
  AssistantImageAttachment,
} from "./types";
import {
  generateText,
  vertexGuideAnswer,
  type VertexInlineImage,
} from "./vertex";
import { guideAnswerToText, type GuideClientTool } from "./guide-schema";
import { isAssistantChat } from "./concept";
import { DOMAIN_FIREWALL_SYSTEM } from "./domain-firewall";
import {
  formatSessionEventsForPrompt,
  isDiagnosisMessage,
} from "@/lib/assistant/packet";
import { COPILOT_WORKFLOW_PACK, glossaryHintsFor } from "@/lib/assistant/product-knowledge";

export { isAssistantChat };

/** Shared formatting contract for plain-text fallback only when structured JSON is unavailable. */
const FORMAT_RULES = `
### OUTPUT FORMAT (required - the UI renders this with spacing and bullets)
Structure every answer like a modern AI assistant:

1) Open with 1–2 short sentences that answer the question directly.
2) Blank line.
3) If you list options or concepts, use a section title on its own line, then bullets:
   What it means
   • Point one
   • Point two
4) Blank line before steps. For how-to, use a section title then numbered steps:
   How to do it
   1. First action - brief detail.
   2. Second action - brief detail.
   3. Third action - brief detail.
5) Optional closing tip on its own line after a blank line (no section needed).

Hard rules:
- Put a blank line between the intro, each section, and the steps.
- One idea per bullet or step. Keep steps short.
- Use "• " for bullets (bullet character) and "1. " "2. " for steps - never walls of paragraphs.
- Do NOT use **bold**, *italic*, markdown # headings, or code fences.
- No fake numbers. Only cite balances/APYs if they appear in pageContext.
`;

const ANSWER_ONLY_SYSTEM = `You are Vanna Assist. Answer fully using pageContext when useful.
Never call yourself Vanna Guide. You explain; Copilot is the one that acts.
No tools. Be concrete and helpful about Vanna (margin, earn, farm, spot).
${DOMAIN_FIREWALL_SYSTEM}
${FORMAT_RULES}`;

function mapGuideClientTools(
  tools?: GuideClientTool[],
): Array<{ name: string; args: Record<string, unknown> }> {
  if (!Array.isArray(tools) || !tools.length) return [];
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const t of tools) {
    if (t.name === "navigateToRoute" && t.path) {
      out.push({ name: "navigateToRoute", args: { path: t.path } });
    } else if (t.name === "scrollToSection" && t.elementId) {
      out.push({ name: "scrollToSection", args: { elementId: t.elementId, highlight: true } });
    } else if (t.name === "highlightElement" && t.selector) {
      out.push({ name: "highlightElement", args: { selector: t.selector } });
    } else if (t.name === "openConnectWallet") {
      out.push({
        name: "openConnectWallet",
        args: {
          ...(t.prefer ? { prefer: t.prefer } : {}),
          ...(t.intent ? { intent: t.intent } : {}),
        },
      });
    }
  }
  return out;
}

/**
 * Offline answer from pageContext when Vertex is down - still answers
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

export type PageAgentExtras = {
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  session_events?: AssistantSessionEvent[];
  attachments?: AssistantImageAttachment[];
  snapshot?: PageSnapshotCtx | null;
  horizon?: { hash: string; status: string; detail: string } | null;
  diagnosing?: boolean;
};

export async function runPageAgent(
  message: string,
  pageContext: SemanticPageContextCtx | null,
  request_id: string,
  extras?: PageAgentExtras | Array<{ role: "user" | "assistant"; text: string }>,
): Promise<ChatResponse> {
  const opts: PageAgentExtras = Array.isArray(extras) ? { history: extras } : extras ?? {};
  const history = opts.history;
  const events = opts.session_events ?? [];
  const images: VertexInlineImage[] = (opts.attachments ?? []).map((a) => ({
    mime: a.mime,
    data: a.data,
  }));
  const snap = opts.snapshot;
  const diagnosing = Boolean(opts.diagnosing || isDiagnosisMessage(message));

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
          regionText: snap?.region_text ? String(snap.region_text).slice(0, 4_000) : null,
          metrics: (snap?.metrics ?? []).slice(0, 30),
          tables: (snap?.tables ?? []).slice(0, 6),
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

  const horizonBlock = opts.horizon
    ? `ON-CHAIN LOOKUP (read only):\nhash=${opts.horizon.hash} status=${opts.horizon.status}\n${opts.horizon.detail}`
    : "";

  const knowledge = [
    formatSessionEventsForPrompt(events),
    horizonBlock,
    glossaryHintsFor(message, pageContext?.path ?? null),
    COPILOT_WORKFLOW_PACK,
  ]
    .filter(Boolean)
    .join("\n\n");

  const user = ["pageContext JSON:", ctxJson, "", knowledge, "", historyBlock, `USER: ${message}`]
    .filter(Boolean)
    .join("\n");

  const guideCtx = [ctxJson, knowledge].join("\n\n");

  try {
    // Single-pass structured call: returns structured GuideAnswer AND any clientTools
    // in one low-latency round-trip across the configured Guide model chain.
    const guide = await vertexGuideAnswer(message, guideCtx || null, history, images);
    const client_tools = mapGuideClientTools(guide?.clientTools);

    let text = "";
    if (!guide) {
      text = await generateText(ANSWER_ONLY_SYSTEM, user, {
        temperature: 0.3,
        images,
        timeoutMs: 45_000,
      });
    }

    const messageOut = guide
      ? guideAnswerToText(guide)
      : text.trim() || "I could not produce an answer from the current page. Try rephrasing your question.";

    return {
      kind: "answer",
      message: messageOut,
      ...(guide ? { guide } : {}),
      data: {
        assistant: true,
        structured_guide: Boolean(guide),
        page_path: pageContext?.path ?? null,
        used_semantic_context: Boolean(pageContext),
        selected: Boolean(pageContext?.selectedText || snap?.selection || snap?.region_text),
        model: "vertex",
        diagnosing,
        session_events: events.length,
        attachments: images.length,
        horizon: opts.horizon?.status ?? null,
        ...(guide?.copilotHandoffPrompt ? { copilotHandoffPrompt: guide.copilotHandoffPrompt } : {}),
      },
      client_tools,
      intent: {
        template_id: "page_assist",
        slots: {
          path: pageContext?.path ?? null,
          mode: diagnosing ? "diagnosis" : client_tools.length ? "semantic_agent" : "explain",
          tools: client_tools.map((t) => t.name),
        },
      },
      request_id,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.warn("[copilot:page-agent] primary failed:", errMsg.slice(0, 200));
    try {
      const fallback = await generateText(ANSWER_ONLY_SYSTEM, user, {
        temperature: 0.3,
        images,
        timeoutMs: 45_000,
      });
      return {
        kind: "answer",
        message: fallback.trim(),
        data: { assistant: true, fallback: true },
        client_tools: [],
        intent: { template_id: "page_assist", slots: { mode: "fallback_text" } },
        request_id,
      };
    } catch (e2) {
      const offline = offlineScreenAnswer(pageContext);
      return {
        kind: "answer",
        message: offline.trim(),
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
