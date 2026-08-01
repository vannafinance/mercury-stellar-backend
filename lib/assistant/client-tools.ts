/**
 * Client-side tool executor (plan Step 2).
 * Tools are decided by Gemini; executed in the browser only.
 */

export type ClientToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type ClientToolResult = {
  name: string;
  ok: boolean;
  detail: string;
};

/** Minimal router surface (Next.js App Router). */
export type SoftRouter = { push: (href: string) => void };

const HIGHLIGHT_CLASS = "copilot-target-highlight";
const HIGHLIGHT_MS = 3000;

function applyHighlight(el: Element) {
  el.classList.add(HIGHLIGHT_CLASS);
  window.setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);
}

/**
 * scrollToSection({ elementId, highlight? })
 */
export function scrollToSection(elementId: string, highlight = true): ClientToolResult {
  const id = String(elementId || "").replace(/^#/, "");
  if (!id) return { name: "scrollToSection", ok: false, detail: "missing elementId" };
  const el = document.getElementById(id);
  if (!el) {
    // Fallback: try data-copilot-id
    const byData = document.querySelector(`[data-copilot-id="${CSS.escape(id)}"]`);
    if (byData) {
      byData.scrollIntoView({ behavior: "smooth", block: "center" });
      if (highlight) applyHighlight(byData);
      return { name: "scrollToSection", ok: true, detail: `scrolled to data-copilot-id=${id}` };
    }
    return { name: "scrollToSection", ok: false, detail: `element not found: ${id}` };
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  if (highlight) applyHighlight(el);
  return { name: "scrollToSection", ok: true, detail: `scrolled to #${id}` };
}

/**
 * highlightElement({ selector })
 */
export function highlightElement(selector: string): ClientToolResult {
  const sel = String(selector || "").trim();
  if (!sel) return { name: "highlightElement", ok: false, detail: "missing selector" };
  let el: Element | null = null;
  try {
    // Prefer data-copilot-id short form
    if (!sel.includes("[") && !sel.startsWith(".") && !sel.startsWith("#")) {
      el =
        document.querySelector(`[data-copilot-id="${CSS.escape(sel)}"]`) ||
        document.getElementById(sel);
    }
    if (!el) el = document.querySelector(sel);
  } catch {
    return { name: "highlightElement", ok: false, detail: `invalid selector: ${sel}` };
  }
  if (!el) return { name: "highlightElement", ok: false, detail: `no match: ${sel}` };
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  applyHighlight(el);
  return { name: "highlightElement", ok: true, detail: `highlighted ${sel}` };
}

/**
 * navigateToRoute({ path }) — soft navigation via Next.js router when provided.
 */
export function navigateToRoute(
  path: string,
  router?: SoftRouter | null,
): ClientToolResult {
  const p = String(path || "").trim();
  if (!p) return { name: "navigateToRoute", ok: false, detail: "missing path" };
  // Only same-origin relative paths
  if (/^https?:\/\//i.test(p) && !p.includes(window.location.host)) {
    return { name: "navigateToRoute", ok: false, detail: "external URL blocked" };
  }
  const rel = p.startsWith("/") ? p : `/${p}`;
  try {
    if (router?.push) {
      router.push(rel);
    } else {
      window.history.pushState({}, "", rel);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    return { name: "navigateToRoute", ok: true, detail: `navigated to ${rel}` };
  } catch (e) {
    return {
      name: "navigateToRoute",
      ok: false,
      detail: e instanceof Error ? e.message : "navigate failed",
    };
  }
}

/**
 * Dispatch one or more tool calls from the LLM response.
 */
export function executeClientTools(
  tools: ClientToolCall[] | null | undefined,
  opts?: { router?: SoftRouter | null },
): ClientToolResult[] {
  if (!tools?.length) return [];
  const results: ClientToolResult[] = [];
  for (const t of tools) {
    const name = String(t.name || "");
    const args = t.args || {};
    if (name === "navigateToRoute") {
      results.push(navigateToRoute(String(args.path ?? ""), opts?.router));
    } else if (name === "scrollToSection") {
      results.push(
        scrollToSection(
          String(args.elementId ?? args.element_id ?? ""),
          args.highlight !== false,
        ),
      );
    } else if (name === "highlightElement") {
      results.push(highlightElement(String(args.selector ?? args.elementId ?? "")));
    } else {
      results.push({ name, ok: false, detail: `unknown client tool: ${name}` });
    }
  }
  return results;
}
