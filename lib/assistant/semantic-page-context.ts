/**
 * Semantic Page Reader — Gemini-style structured pageContext.
 * Do NOT send raw document.body.innerHTML. Clean JSON only.
 */

export type PageSection = {
  level: 1 | 2 | 3;
  text: string;
  id: string | null;
};

/** Payload shape from the master assistant plan (Gemini). */
export type SemanticPageContext = {
  url: string;
  path: string;
  title: string;
  description: string;
  sections: PageSection[];
  mainText: string;
  selectedText: string | null;
  /** Optional: data-copilot-id targets found on page for highlight tools */
  interactiveHints: Array<{ id: string; label: string }>;
  capturedAt: number;
};

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "SVG",
  "CANVAS",
  "IFRAME",
  "VIDEO",
  "AUDIO",
  "META",
  "LINK",
]);

const SKIP_SELECTORS =
  "[data-assistant-panel],[data-assistant-ignore],[data-assistant-overlay],[aria-hidden='true'],nav,footer,[role='navigation'],[role='banner'],.Toaster,[data-sonner-toaster]";

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  const st = window.getComputedStyle(el);
  if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
  return true;
}

function ensureSectionId(el: HTMLElement, index: number): string | null {
  if (el.id) return el.id;
  // Synthetic stable-ish id for scroll tools when authors omit id
  const slug = clean(el.textContent || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  if (!slug) return null;
  const id = `copilot-section-${slug || index}`;
  if (!document.getElementById(id)) {
    try {
      el.id = id;
    } catch {
      return null;
    }
  }
  return el.id || id;
}

function extractSections(root: Element): PageSection[] {
  const out: PageSection[] = [];
  root.querySelectorAll("h1, h2, h3").forEach((node, i) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.closest(SKIP_SELECTORS) || !isVisible(node)) return;
    const level = Number(node.tagName[1]) as 1 | 2 | 3;
    const text = clean(node.textContent || "");
    if (!text) return;
    out.push({
      level,
      text,
      id: ensureSectionId(node, i),
    });
  });
  return out.slice(0, 60);
}

function extractMainText(root: Element, maxChars: number): string {
  const parts: string[] = [];
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest(SKIP_SELECTORS)) return NodeFilter.FILTER_REJECT;
      if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
      if (!clean(node.textContent || "")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null = walker.nextNode();
  while (n && total < maxChars) {
    const t = clean(n.textContent || "");
    if (t) {
      const slice = t.slice(0, maxChars - total);
      parts.push(slice);
      total += slice.length + 1;
    }
    n = walker.nextNode();
  }
  // de-dupe consecutive
  const deduped: string[] = [];
  for (const p of parts) {
    if (deduped[deduped.length - 1] === p) continue;
    deduped.push(p);
  }
  return deduped.join("\n").slice(0, maxChars);
}

function extractInteractiveHints(root: Element): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  root.querySelectorAll("[data-copilot-id]").forEach((el) => {
    const id = el.getAttribute("data-copilot-id");
    if (!id) return;
    const label = clean(el.getAttribute("aria-label") || el.textContent || id).slice(0, 80);
    out.push({ id, label });
  });
  return out.slice(0, 40);
}

function readMetaDescription(): string {
  const el =
    document.querySelector('meta[name="description"]') ||
    document.querySelector('meta[property="og:description"]');
  return clean(el?.getAttribute("content") || "");
}

function readSelection(): string | null {
  try {
    const t = window.getSelection()?.toString()?.trim();
    return t ? t.slice(0, 2_000) : null;
  } catch {
    return null;
  }
}

/**
 * Serialize the active page into the plan's semantic JSON schema.
 * Call on load, route change, and immediately before each assistant send.
 */
export function captureSemanticPageContext(opts?: {
  maxMainText?: number;
}): SemanticPageContext {
  const maxMainText = opts?.maxMainText ?? 12_000;
  const path = window.location.pathname + window.location.search;
  const url = window.location.href.split("#")[0];
  const title = document.title || "";
  const description = readMetaDescription();

  const root =
    document.querySelector("main") ||
    document.querySelector("article") ||
    document.querySelector("[role='main']") ||
    document.body;

  const sections = root ? extractSections(root) : [];
  const mainText = root ? extractMainText(root, maxMainText) : "";
  const interactiveHints = root ? extractInteractiveHints(root) : [];
  const selectedText = readSelection();

  return {
    url,
    path,
    title,
    description,
    sections,
    mainText,
    selectedText,
    interactiveHints,
    capturedAt: Date.now(),
  };
}
