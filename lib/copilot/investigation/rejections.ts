/**
 * Refused shapes, said once per cause.
 *
 * 8 Oct, live: "borrow the maximum I can safely" came back as three refusals that differed only by asset
 * ("Borrow SOUSDC ... needs the health-factor floor you want kept", the same for XLM and for BLUSDC). One missing
 * answer was being reported three times. Shapes that were refused for the same cause are listed together, followed
 * by the cause once. The cause is carried on the row (`cause`, the reason before the leg is prefixed to it), so
 * nothing here reads the wording of a sentence.
 */
export interface RefusedShape { label: string; reason: string; cause?: string }

export function groupRejections(rows: readonly RefusedShape[]): Array<{ labels: string[]; cause: string }> {
  const groups = new Map<string, { labels: string[]; cause: string }>();
  for (const row of rows) {
    const cause = row.cause ?? row.reason;
    const found = groups.get(cause);
    if (found) { if (!found.labels.includes(row.label)) found.labels.push(row.label); } else groups.set(cause, { labels: [row.label], cause });
  }
  return [...groups.values()];
}

/**
 * The one sentence for a turn where every refused shape was refused for the same cause, or null when the causes differ.
 * A single refused shape keeps its label ("Supply 10 BLUSDC to Blend - Blend has no AQUSDC reserve"); several shapes
 * sharing a cause need only the cause, which already speaks to the person ("... tell me the number, or state the
 * amount"). The first letter is capitalised, nothing else about the text is touched.
 */
export function soleRejection(rows: readonly RefusedShape[]): string | null {
  const groups = groupRejections(rows);
  if (groups.length !== 1) return null;
  const { labels, cause } = groups[0];
  const text = cause.replace(/\.$/, "");
  return labels.length === 1 ? `${labels[0]} - ${text}` : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** "Label, Label - cause; Label - cause", at most `max` groups, each cause once without its closing full stop. */
export function describeRejections(rows: readonly RefusedShape[], max = 3): string {
  return groupRejections(rows).slice(0, max).map((group) => `${group.labels.join(", ")} - ${group.cause.replace(/\.$/, "")}`).join("; ");
}
