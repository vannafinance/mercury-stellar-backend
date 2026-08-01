/**
 * Live page capture for the site-wide assistant (Gemini-in-Chrome style).
 *
 * Reads what is actually rendered in the DOM — not a hand-maintained per-page
 * registry. Runs only in the browser at open/send time.
 */

export type PageSnapshot = {
  /** pathname e.g. /analytics/risk-explorer/black-swan */
  path: string;
  /** document.title */
  title: string;
  /** Full URL (no secrets) */
  url: string;
  /** Visible text extracted from the page */
  visible_text: string;
  /** User text selection, if any */
  selection: string | null;
  /** Approximate heading outline */
  headings: string[];
  captured_at: number;
  char_count: number;
};

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "SVG",
  "PATH",
  "CANVAS",
  "IFRAME",
  "VIDEO",
  "AUDIO",
  "SOURCE",
  "META",
  "LINK",
  "HEAD",
]);

/** Elements we never want in assistant context (chrome / noise). */
const SKIP_SELECTORS = [
  "[data-assistant-panel]",
  "[data-assistant-ignore]",
  "[aria-hidden='true']",
  "nav",
  "footer",
  "[role='navigation']",
  "[role='banner']",
  ".Toaster",
  "[data-sonner-toaster]",
].join(",");

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  const s = window.getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
  if (el.offsetParent === null && s.position !== "fixed" && s.position !== "sticky") {
    // Many flex children still count; only skip if both dims are 0
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
  }
  return true;
}

/**
 * Walk the DOM and collect visible text in reading order.
 * Caps output so prompts stay bounded.
 */
export function capturePageSnapshot(opts?: {
  maxChars?: number;
  root?: Element | null;
}): PageSnapshot {
  const maxChars = opts?.maxChars ?? 14_000;
  const path = typeof window !== "undefined" ? window.location.pathname : "";
  const title = typeof document !== "undefined" ? document.title : "";
  const url = typeof window !== "undefined" ? window.location.href.split("#")[0] : "";

  let selection: string | null = null;
  try {
    const sel = window.getSelection()?.toString()?.trim();
    if (sel && sel.length > 0) selection = sel.slice(0, 2_000);
  } catch {
    selection = null;
  }

  const root =
    opts?.root ||
    document.querySelector("main") ||
    document.querySelector("[role='main']") ||
    document.body;

  const headings: string[] = [];
  const parts: string[] = [];
  let total = 0;

  const push = (line: string) => {
    const t = line.replace(/\s+/g, " ").trim();
    if (!t) return;
    if (total >= maxChars) return;
    const next = t.slice(0, maxChars - total);
    parts.push(next);
    total += next.length + 1;
  };

  if (!root) {
    return {
      path,
      title,
      url,
      visible_text: "",
      selection,
      headings,
      captured_at: Date.now(),
      char_count: 0,
    };
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(SKIP_SELECTORS)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
        const text = node.textContent?.replace(/\s+/g, " ").trim();
        if (!text) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (el.matches?.(SKIP_SELECTORS) || el.closest(SKIP_SELECTORS)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP; // continue into children
      }
      return NodeFilter.FILTER_REJECT;
    },
  });

  let lastWasBlock = true;
  let buf = "";
  const flush = () => {
    if (buf.trim()) push(buf);
    buf = "";
  };

  let n: Node | null = walker.nextNode();
  while (n && total < maxChars) {
    if (n.nodeType === Node.TEXT_NODE) {
      const parent = n.parentElement;
      const text = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (text) {
        const tag = parent?.tagName || "";
        if (/^H[1-6]$/.test(tag)) {
          flush();
          headings.push(text);
          push(`# ${text}`);
          lastWasBlock = true;
        } else if (tag === "BUTTON" || tag === "A") {
          // Keep controls as short cues
          if (text.length < 80) {
            if (!lastWasBlock) buf += " · ";
            buf += `[${text}]`;
            lastWasBlock = false;
          }
        } else if (tag === "LABEL" || tag === "TH" || tag === "DT") {
          flush();
          buf = `${text}:`;
          lastWasBlock = false;
        } else {
          if (lastWasBlock) {
            buf = text;
          } else {
            buf += (buf.endsWith(":") ? " " : " ") + text;
          }
          lastWasBlock = false;
          // Heuristic: after a value-looking token, break line
          if (/(\$[\d,.]+|[\d,.]+%|∞|\d+\.\d{2,}x?)$/.test(buf) || buf.length > 120) {
            flush();
            lastWasBlock = true;
          }
        }
      }
    }
    n = walker.nextNode();
  }
  flush();

  // De-dupe consecutive identical lines (tables/shimmer noise)
  const deduped: string[] = [];
  for (const line of parts) {
    if (deduped[deduped.length - 1] === line) continue;
    deduped.push(line);
  }

  const visible_text = deduped.join("\n").slice(0, maxChars);

  return {
    path,
    title,
    url,
    visible_text,
    selection,
    headings: headings.slice(0, 30),
    captured_at: Date.now(),
    char_count: visible_text.length,
  };
}
