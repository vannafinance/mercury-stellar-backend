import { allAssets, lpVenues, isAmbiguousUsdc } from "../registry/assets";
import { WORKFLOW_OPS } from "../workflow/types";

export type NameKind = "asset" | "venue" | "op";

export interface NameCandidate {
  id: string;
  label: string;
  kind: string;
  distance: number;
}

export interface NameResolution {
  kind: "exact" | "near" | "none";
  candidates: NameCandidate[];
}

/**
 * Length-scaled edit distance thresholds for typo tolerance:
 * - Length < 4: 0 edits (exact match only; prevents dangerous 3-letter collisions)
 * - Length 4-6: 1 edit
 * - Length 7-10: 2 edits
 * - Length >= 11: 3 edits (allows long compound names like "aquariususdc" / "aquiresusdc" to resolve;
 *   kept because distance >= 2 only ever asks a clarification question, never silently assumes or auto-executes)
 */
export const DISTANCE_THRESHOLDS: ReadonlyArray<{ maxLen: number; maxEdits: number }> = [
  { maxLen: 3, maxEdits: 0 },
  { maxLen: 6, maxEdits: 1 },
  { maxLen: 10, maxEdits: 2 },
  { maxLen: Infinity, maxEdits: 3 },
] as const;

export function maxEditsForLength(len: number): number {
  for (const { maxLen, maxEdits } of DISTANCE_THRESHOLDS) {
    if (len <= maxLen) return maxEdits;
  }
  return 3;
}

/**
 * Words that are common English vocabulary and MUST NEVER be fuzzy-matched.
 *
 * Rationale: Length-scaled edit distance turns "send" into an assumed "lend",
 * "lead" into "lend", and "learn" into "earn". Silently assuming a financial
 * operation from everyday English words carries financial risk.
 *
 * These words still match as `exact` when typed exactly (case-insensitive),
 * so domain gates continue to recognize valid ops and common venues.
 */
export const EXACT_ONLY_VOCABULARY = new Set<string>([
  "EARN",
  "BLEND",
  "MARGIN",
  ...WORKFLOW_OPS.map((op) => op.toUpperCase()),
  ...WORKFLOW_OPS.map((op) => op.replace(/_/g, " ").toUpperCase()),
]);

/**
 * Damerau-Levenshtein distance: insertions, deletions, substitutions,
 * and transpositions of adjacent characters.
 */
export function damerauLevenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const matrix: number[][] = [];
  for (let i = 0; i <= al; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= bl; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let min = Math.min(
        matrix[i - 1][j] + 1,       // deletion
        matrix[i][j - 1] + 1,       // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        min = Math.min(min, matrix[i - 2][j - 2] + 1); // transposition
      }

      matrix[i][j] = min;
    }
  }

  return matrix[al][bl];
}

interface VocabEntry {
  id: string;
  label: string;
  kind: NameKind;
  isExactOnly: boolean;
}

function buildVocabulary(): VocabEntry[] {
  const vocab: VocabEntry[] = [];

  // 1. Assets: distinctive aliases and display labels from registry
  for (const def of allAssets()) {
    for (const alias of def.aliases) {
      vocab.push({ id: def.id, label: alias, kind: "asset", isExactOnly: false });
    }
    vocab.push({ id: def.id, label: def.displayLabel, kind: "asset", isExactOnly: false });
  }

  // 2. LP venues
  for (const venue of lpVenues()) {
    vocab.push({ id: venue, label: venue, kind: "venue", isExactOnly: false });
  }

  // 3. Exact-only venues
  const commonVenues = ["margin", "earn", "blend"] as const;
  for (const venue of commonVenues) {
    vocab.push({ id: venue, label: venue, kind: "venue", isExactOnly: true });
  }

  // 4. Exact-only ops
  for (const op of WORKFLOW_OPS) {
    vocab.push({ id: op, label: op, kind: "op", isExactOnly: true });
    vocab.push({ id: op, label: op.replace(/_/g, " "), kind: "op", isExactOnly: true });
  }

  return vocab;
}

const VOCABULARY = buildVocabulary();

/**
 * Resolves a user-provided word to registered asset, venue, or op names.
 *
 * Rules:
 * 1. Bare "USDC" returns `none` to preserve the which-USDC flow.
 * 2. Words in `EXACT_ONLY_VOCABULARY` only match when exact (distance 0).
 * 3. Distance uses Damerau-Levenshtein with length-scaled thresholds.
 * 4. Ties at minimal distance are all returned.
 */
export function resolveName(
  word: string,
  kinds: readonly NameKind[] = ["asset", "venue", "op"]
): NameResolution {
  const trimmed = word.trim();
  if (!trimmed) return { kind: "none", candidates: [] };

  const upper = trimmed.toUpperCase();

  // Bare USDC returns none — handled exclusively by which-USDC flow
  if (upper === "USDC" || isAmbiguousUsdc(trimmed)) {
    return { kind: "none", candidates: [] };
  }

  const allowedKinds = new Set(kinds);
  const relevantEntries = VOCABULARY.filter((v) => allowedKinds.has(v.kind));

  // Step 1: Check for exact matches (distance 0)
  const exactMatches: NameCandidate[] = [];
  const seenExactIds = new Set<string>();

  for (const entry of relevantEntries) {
    if (entry.label.toUpperCase() === upper) {
      if (!seenExactIds.has(entry.id)) {
        seenExactIds.add(entry.id);
        exactMatches.push({
          id: entry.id,
          label: entry.label,
          kind: entry.kind,
          distance: 0,
        });
      }
    }
  }

  if (exactMatches.length > 0) {
    return { kind: "exact", candidates: exactMatches };
  }

  // Step 2: Check for near matches against distinctive names only
  const maxEdits = maxEditsForLength(upper.length);
  if (maxEdits === 0) {
    // Length < 4 allows 0 edits; no exact match was found above
    return { kind: "none", candidates: [] };
  }

  // Non-distinctive words (EXACT_ONLY_VOCABULARY) are NEVER matched fuzzy
  const distinctiveEntries = relevantEntries.filter(
    (entry) => !entry.isExactOnly && !EXACT_ONLY_VOCABULARY.has(entry.label.toUpperCase())
  );

  let bestDist = Infinity;
  const candidatesByDist: Map<number, NameCandidate[]> = new Map();
  const seenNearIds = new Set<string>();

  for (const entry of distinctiveEntries) {
    const candidateUpper = entry.label.toUpperCase();
    const dist = damerauLevenshtein(upper, candidateUpper);

    if (dist <= maxEdits) {
      const key = `${entry.id}:${dist}`;
      if (!seenNearIds.has(key)) {
        seenNearIds.add(key);
        const candidate: NameCandidate = {
          id: entry.id,
          label: entry.label,
          kind: entry.kind,
          distance: dist,
        };

        if (dist < bestDist) {
          bestDist = dist;
        }

        const list = candidatesByDist.get(dist) ?? [];
        list.push(candidate);
        candidatesByDist.set(dist, list);
      }
    }
  }

  if (bestDist <= maxEdits) {
    const ties = candidatesByDist.get(bestDist) ?? [];
    if (ties.length > 0) {
      return { kind: "near", candidates: ties };
    }
  }

  return { kind: "none", candidates: [] };
}
