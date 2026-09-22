/**
 * Shared "can the user actually see this?" test for the Assistant.
 *
 * Both the page capture and the highlight tools need the same answer, and they need it
 * about ancestors too: Tailwind's responsive `hidden` sets `display: none` on a WRAPPER,
 * so a panel inside the mobile sheet reports its own styles as perfectly visible. The
 * Earn and Farm forms mount the same panel twice for that reason, which is why checking
 * only the element itself offered the model the off-screen copy.
 */

/**
 * Only a computed opacity that really parses to 0 counts as hidden.
 *
 * `Number(style.opacity) === 0` is the trap this replaces: a computed style that returns
 * an empty string coerces to 0, marking every element on the page hidden — which turned
 * the visible-first lookup back into "first match in document order" and made the page
 * capture come back empty.
 */
export function isTransparent(opacity: string): boolean {
  if (!opacity) return false;
  const value = Number.parseFloat(opacity);
  return Number.isFinite(value) && value === 0;
}

/** True when the element and every ancestor are displayed. */
export function isElementOnScreen(el: Element): boolean {
  if (typeof window === "undefined") return true;
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    if (node instanceof HTMLElement) {
      const style = window.getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        isTransparent(style.opacity)
      ) {
        return false;
      }
      if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") {
        return false;
      }
    }
    node = node.parentElement;
  }
  return true;
}
