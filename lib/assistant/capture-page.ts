/**
 * Live page capture for the site-wide assistant (Gemini-in-Chrome style).
 * Reads what is actually rendered in the DOM — any route.
 */

export type PageSnapshot = {
  path: string;
  title: string;
  url: string;
  visible_text: string;
  selection: string | null;
  /** Optional region crop text (select-from-screen) */
  region_text?: string | null;
  headings: string[];
  /** Structured label→value pairs when detectable */
  metrics: Array<{ label: string; value: string }>;
  tables: string[];
  captured_at: number;
  char_count: number;
};

export type CaptureRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
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

const SKIP_SELECTORS = [
  "[data-assistant-panel]",
  "[data-assistant-ignore]",
  "[data-assistant-overlay]",
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
  if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
  if (el.offsetParent === null && s.position !== "fixed" && s.position !== "sticky") {
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
  }
  return true;
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function intersects(a: DOMRect, r: CaptureRect): boolean {
  return !(a.right < r.left || a.left > r.right || a.bottom < r.top || a.top > r.bottom);
}

function pushBounded(parts: string[], total: { n: number }, max: number, line: string) {
  const t = clean(line);
  if (!t || total.n >= max) return;
  const next = t.slice(0, max - total.n);
  parts.push(next);
  total.n += next.length + 1;
}

/** Extract table rows as "col1 | col2 | col3" lines. */
function extractTables(root: Element, maxTables = 8): string[] {
  const out: string[] = [];
  const tables = root.querySelectorAll("table");
  tables.forEach((table, ti) => {
    if (ti >= maxTables) return;
    if (table.closest(SKIP_SELECTORS)) return;
    if (!isVisible(table)) return;
    const rows: string[] = [];
    table.querySelectorAll("tr").forEach((tr) => {
      const cells = [...tr.querySelectorAll("th,td")]
        .map((c) => clean(c.textContent || ""))
        .filter(Boolean);
      if (cells.length) rows.push(cells.join(" | "));
    });
    if (rows.length) {
      out.push(`TABLE ${ti + 1}:\n${rows.slice(0, 40).join("\n")}`);
    }
  });
  return out;
}

/**
 * Heuristic label/value pairs from common DeFi card layouts:
 * - parent with two text children (label + value)
 * - elements with data-label
 * - dt/dd pairs
 */
function extractMetrics(root: Element, max = 40): Array<{ label: string; value: string }> {
  const found: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();

  const add = (label: string, value: string) => {
    const l = clean(label);
    const v = clean(value);
    if (!l || !v || l.length > 80 || v.length > 80) return;
    // Prefer value-looking tokens
    if (!/[\d$%∞]|USDC|XLM|BLUSDC|AQUSDC|SOUSDC/i.test(v) && v.length > 40) return;
    const key = `${l}::${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ label: l, value: v });
  };

  root.querySelectorAll("dt").forEach((dt) => {
    const dd = dt.nextElementSibling;
    if (dd && dd.tagName === "DD") add(dt.textContent || "", dd.textContent || "");
  });

  root.querySelectorAll("[data-label]").forEach((el) => {
    const label = el.getAttribute("data-label") || "";
    add(label, el.textContent || "");
  });

  // Grid/card: short text node sibling patterns
  root.querySelectorAll("div, li, section, article").forEach((el) => {
    if (found.length >= max) return;
    if (el.closest(SKIP_SELECTORS) || !isVisible(el)) return;
    const kids = [...el.children].filter((c) => isVisible(c) && !SKIP_TAGS.has(c.tagName));
    if (kids.length < 2 || kids.length > 6) return;
    const texts = kids.map((k) => clean(k.textContent || "")).filter(Boolean);
    if (texts.length === 2) {
      const [a, b] = texts;
      // label then value, or value then label
      if (a.length < 48 && /[\d$%∞]/.test(b)) add(a, b);
      else if (b.length < 48 && /[\d$%∞]/.test(a)) add(b, a);
    }
  });

  return found.slice(0, max);
}

function collectText(
  root: Element,
  maxChars: number,
  region?: CaptureRect | null,
): { parts: string[]; headings: string[] } {
  const parts: string[] = [];
  const headings: string[] = [];
  const total = { n: 0 };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(SKIP_SELECTORS)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
        if (region) {
          const r = parent.getBoundingClientRect();
          if (!intersects(r, region)) return NodeFilter.FILTER_REJECT;
        }
        if (!clean(node.textContent || "")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (el.matches?.(SKIP_SELECTORS) || el.closest(SKIP_SELECTORS)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
        if (region) {
          const r = el.getBoundingClientRect();
          // Keep ancestors that contain the region; reject far-away branches
          if (r.width > 0 && r.height > 0 && !intersects(r, region)) {
            // Still allow if children might intersect (overlap partial)
            if (r.right < region.left || r.left > region.right || r.bottom < region.top || r.top > region.bottom) {
              return NodeFilter.FILTER_REJECT;
            }
          }
        }
        // Prefer structured table extraction over walking every cell twice
        if (el.tagName === "TABLE") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_REJECT;
    },
  });

  let lastWasBlock = true;
  let buf = "";
  const flush = () => {
    if (buf.trim()) pushBounded(parts, total, maxChars, buf);
    buf = "";
  };

  let n: Node | null = walker.nextNode();
  while (n && total.n < maxChars) {
    if (n.nodeType === Node.TEXT_NODE) {
      const parent = n.parentElement;
      const text = clean(n.textContent || "");
      if (text) {
        const tag = parent?.tagName || "";
        if (/^H[1-6]$/.test(tag)) {
          flush();
          headings.push(text);
          pushBounded(parts, total, maxChars, `HEADING: ${text}`);
          lastWasBlock = true;
        } else if (tag === "TH" || tag === "TD") {
          // tables handled separately
        } else if (tag === "BUTTON" || (tag === "A" && text.length < 60)) {
          if (!lastWasBlock) buf += " · ";
          buf += `[${text}]`;
          lastWasBlock = false;
        } else if (tag === "LABEL" || tag === "DT") {
          flush();
          buf = `${text}:`;
          lastWasBlock = false;
        } else {
          if (lastWasBlock) buf = text;
          else buf += (buf.endsWith(":") ? " " : " ") + text;
          lastWasBlock = false;
          if (/(\$[\d,.]+|[\d,.]+%|∞|\d+\.\d{2,}x?)$/.test(buf) || buf.length > 100) {
            flush();
            lastWasBlock = true;
          }
        }
      }
    }
    n = walker.nextNode();
  }
  flush();

  const deduped: string[] = [];
  for (const line of parts) {
    if (deduped[deduped.length - 1] === line) continue;
    deduped.push(line);
  }
  return { parts: deduped, headings };
}

/**
 * Capture visible page (full main content or a screen region).
 */
export function capturePageSnapshot(opts?: {
  maxChars?: number;
  root?: Element | null;
  region?: CaptureRect | null;
  regionText?: string | null;
}): PageSnapshot {
  const maxChars = opts?.maxChars ?? 14_000;
  const path = typeof window !== "undefined" ? window.location.pathname : "";
  const title = typeof document !== "undefined" ? document.title : "";
  const url = typeof window !== "undefined" ? window.location.href.split("#")[0] : "";

  let selection: string | null = null;
  try {
    const sel = window.getSelection()?.toString()?.trim();
    if (sel) selection = sel.slice(0, 2_000);
  } catch {
    selection = null;
  }

  const root =
    opts?.root ||
    document.querySelector("main") ||
    document.querySelector("[role='main']") ||
    document.body;

  if (!root) {
    return {
      path,
      title,
      url,
      visible_text: "",
      selection,
      region_text: opts?.regionText ?? null,
      headings: [],
      metrics: [],
      tables: [],
      captured_at: Date.now(),
      char_count: 0,
    };
  }

  const region = opts?.region ?? null;
  const { parts, headings } = collectText(root, maxChars, region);
  const metrics = extractMetrics(root);
  const tables = extractTables(root);

  const structured: string[] = [];
  if (metrics.length) {
    structured.push(
      "DETECTED METRICS:",
      ...metrics.map((m) => `${m.label}: ${m.value}`),
      "",
    );
  }
  if (tables.length) {
    structured.push("DETECTED TABLES:", ...tables, "");
  }

  const body = parts.join("\n");
  const visible_text = [...structured, "PAGE TEXT:", body].join("\n").slice(0, maxChars);
  const region_text = opts?.regionText
    ? opts.regionText
    : region
      ? collectText(root, 6_000, region).parts.join("\n").slice(0, 6_000)
      : null;

  return {
    path,
    title,
    url,
    visible_text,
    selection,
    region_text,
    headings: headings.slice(0, 40),
    metrics,
    tables,
    captured_at: Date.now(),
    char_count: visible_text.length,
  };
}

/** Capture only elements under a viewport rectangle (select-from-screen). */
export function captureRegion(rect: CaptureRect, maxChars = 6_000): PageSnapshot {
  return capturePageSnapshot({ maxChars: 14_000, region: rect, regionText: null });
}
