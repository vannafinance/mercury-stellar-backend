/**
 * Which brain served a turn. /copilot free-text is investigation; keyword
 * routing is the page assistant and leftover /api/copilot shims only.
 */
export type ServedBrain = "investigation" | "keyword_router" | "copilot_shim";

const counts: Record<ServedBrain, number> = {
  investigation: 0,
  keyword_router: 0,
  copilot_shim: 0,
};

export function noteBrain(brain: ServedBrain): void {
  counts[brain] += 1;
}

export function brainCounts(): Readonly<Record<ServedBrain, number>> {
  return { ...counts };
}

export function resetBrainCounts(): void {
  counts.investigation = 0;
  counts.keyword_router = 0;
  counts.copilot_shim = 0;
}

/** Fraction of planner turns that still hit the keyword router. */
export function keywordRouterShare(): { router: number; investigation: number; share: number } {
  const router = counts.keyword_router;
  const investigation = counts.investigation;
  const total = router + investigation;
  return { router, investigation, share: total === 0 ? 0 : router / total };
}
