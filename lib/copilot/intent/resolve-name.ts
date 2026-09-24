/**
 * Contract owned by the name-resolver task. This file is the stand-in until that
 * implementation is merged: it answers `none` for every word and does not score typos.
 * Callers treat `exact` and `near` as a domain name. Claude replaces this module at merge.
 */
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

export function resolveName(_word: string, _kinds: readonly NameKind[]): NameResolution {
  return { kind: "none", candidates: [] };
}
