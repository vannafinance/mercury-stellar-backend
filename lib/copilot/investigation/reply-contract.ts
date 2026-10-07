import { bindSegments, formatFactValue } from "./answer-prose";
import type { ReplyBlock, ReplySegment, ResearchFact } from "./view";

/** Presentation budgets, independent of request wording, asset or venue. */
export const REPLY_LIMITS = { blocks: 8, items: 12, segments: 12, text: 700 } as const;

const SEGMENTS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["text", "fact"] },
      text: { type: "string" }, factId: { type: "string" },
    },
    required: ["type"],
  },
};

/** A finite vocabulary of reusable blocks, not a schema per financial use case.
 * Nested size budgets are checked below rather than multiplied in the decoder schema;
 * Vertex rejected that expanded constraint set during live verification.
 */
export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    blocks: {
      type: "array", minItems: 1, maxItems: REPLY_LIMITS.blocks,
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["paragraph", "heading", "bullets", "steps", "table"] },
          segments: SEGMENTS_SCHEMA,
          items: { type: "array", items: SEGMENTS_SCHEMA },
          columns: { type: "array", items: SEGMENTS_SCHEMA },
          rows: { type: "array", items: { type: "array", items: SEGMENTS_SCHEMA } },
        },
        required: ["type"],
      },
    },
  },
  required: ["blocks"],
};

/** Carry meaning and provenance as data, rather than infer them from a rendered number. */
export function replyFactContext(fact: ResearchFact) {
  return {
    id: fact.id, label: fact.label, shown: formatFactValue(fact), unit: fact.unit,
    venue: fact.venue, quantity: fact.quantity ?? null, requested: fact.requested ?? false,
    evidence: { id: fact.evidenceId, path: fact.sourcePath, readAt: fact.readAt || null },
  };
}

export type BoundReply = { ok: true; blocks: ReplyBlock[] } | { ok: false; reason: string };
const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const only = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).every((key) => keys.includes(key));

/** Validate generated blocks and bind figures before they reach the browser. */
export function bindReplyBlocks(raw: unknown, facts: readonly ResearchFact[]): BoundReply {
  if (!record(raw) || !only(raw, ["blocks"]) || !Array.isArray(raw.blocks)
    || !raw.blocks.length || raw.blocks.length > REPLY_LIMITS.blocks) return { ok: false, reason: "no usable blocks" };
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  if (byId.size !== facts.length) return { ok: false, reason: "ambiguous fact identity" };
  const blocks: ReplyBlock[] = [];
  let citations = 0;
  let reason = "invalid segments";
  const bind = (rawSegments: unknown): ReplySegment[] | null => {
    // Migration support for callers producing the previous wire grammar; the new schema
    // generates typed references exclusively. Stored bound blocks are not parsed here.
    if (typeof rawSegments === "string") {
      if (!rawSegments.trim() || rawSegments.length > REPLY_LIMITS.text) { reason = "segment text empty or too long"; return null; }
      const result = bindSegments(rawSegments, facts);
      if (!result.ok) { reason = result.reason; return null; }
      citations += result.cited.length;
      return result.segments;
    }
    if (!Array.isArray(rawSegments) || !rawSegments.length || rawSegments.length > REPLY_LIMITS.segments) { reason = "segments missing, empty or too many"; return null; }
    const out: ReplySegment[] = [];
    let textLength = 0;
    for (const segment of rawSegments) {
      if (!record(segment)) { reason = "a segment is not an object"; return null; }
      if (segment.type === "fact" && only(segment, ["type", "factId"]) && typeof segment.factId === "string") {
        const fact = byId.get(segment.factId);
        if (!fact) { reason = "reply cites a fact that was not read"; return null; }
        out.push({ text: formatFactValue(fact), figure: true, factId: fact.id });
        citations++;
      } else if (segment.type === "text" && only(segment, ["type", "text"]) && typeof segment.text === "string" && segment.text.length) {
        const text = segment.text;
        textLength += text.length;
        if (textLength > REPLY_LIMITS.text) { reason = "paragraph text too long"; return null; }
        // This is display validation, never natural-language intent parsing.
        if ([...text].some((c) => c >= "0" && c <= "9")) { reason = "reply contains a figure the model wrote itself"; return null; }
        if (["<", ">", "`", "*", "#", "_", "{{", "}}", "](", "://", "www."].some((token) => text.toLowerCase().includes(token))) {
          reason = "reply contains markup or a link"; return null;
        }
        out.push({ text: segment.text });
      } else { reason = "a segment has the wrong keys or type"; return null; }
    }
    if (!out.some((segment) => segment.text.trim())) { reason = "segments carry no words"; return null; }
    return out;
  };
  const bindItems = (items: unknown): ReplySegment[][] | null => {
    if (!Array.isArray(items) || !items.length || items.length > REPLY_LIMITS.items) return null;
    const out: ReplySegment[][] = [];
    for (const item of items) { const bound = bind(item); if (!bound) return null; out.push(bound); }
    return out;
  };
  for (const block of raw.blocks) {
    if (!record(block)) return { ok: false, reason: "unknown block" };
    if (block.type === "paragraph" || block.type === "heading") {
      if (!only(block, ["type", "segments", "text"]) || (block.segments !== undefined && block.text !== undefined)) return { ok: false, reason: "invalid block fields" };
      const segments = bind(block.segments ?? block.text);
      if (!segments) return { ok: false, reason };
      blocks.push({ type: block.type, segments });
    } else if (block.type === "bullets" || block.type === "steps") {
      if (!only(block, ["type", "items"])) return { ok: false, reason: "invalid block fields" };
      const items = bindItems(block.items);
      if (!items) return { ok: false, reason };
      blocks.push({ type: block.type, items });
    } else if (block.type === "table") {
      if (!only(block, ["type", "columns", "rows"])) return { ok: false, reason: "invalid block fields" };
      const columns = bindItems(block.columns);
      if (!columns || !Array.isArray(block.rows) || !block.rows.length || block.rows.length > REPLY_LIMITS.items) return { ok: false, reason: "invalid table" };
      const rows: ReplySegment[][][] = [];
      for (const row of block.rows) {
        const cells = bindItems(row);
        if (!cells || cells.length !== columns.length) return { ok: false, reason: "invalid table" };
        rows.push(cells);
      }
      blocks.push({ type: "table", columns, rows });
    } else return { ok: false, reason: "unknown block" };
  }
  return citations ? { ok: true, blocks } : { ok: false, reason: "reply cites no fact" };
}

const textOf = (segments: readonly ReplySegment[]) => segments.map((segment) => segment.text).join("");

/** A lossless plain-text companion for history and clients without block rendering. */
export function plainReply(blocks: readonly ReplyBlock[]): string {
  return blocks.map((block) => {
    if (block.type === "table") return [block.columns.map(textOf).join(" | "), ...block.rows.map((row) => row.map(textOf).join(" | "))].join("\n");
    if (block.type === "bullets" || block.type === "steps") return block.items.map((item, index) => `${block.type === "steps" ? `${index + 1}.` : "•"} ${textOf(item)}`).join("\n");
    return textOf(block.segments);
  }).join("\n\n");
}
