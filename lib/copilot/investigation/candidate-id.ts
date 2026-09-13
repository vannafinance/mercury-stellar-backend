/**
 * One owner of investigation candidate ids.
 *
 * Producers mint through `candidateId`. The propose route validates with
 * `isCandidateId`. A new kind (or a symbol with digits/hyphens) cannot drift
 * from the wire shape by copying a regex somewhere else.
 */
export const CANDIDATE_ID_PATTERN = /^[a-z0-9_]{1,80}$/;

export function isCandidateId(value: string): boolean {
  return CANDIDATE_ID_PATTERN.test(value);
}

function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function candidateId(kind: string, ...parts: string[]): string {
  const id = [kind, ...parts].map(slugPart).filter(Boolean).join("_").slice(0, 80);
  if (!isCandidateId(id)) throw new Error(`invalid_candidate_id:${id}`);
  return id;
}
