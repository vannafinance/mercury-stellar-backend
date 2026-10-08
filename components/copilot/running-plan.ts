/**
 * Which plan is running, for the line above the execution card.
 *
 * 8 Oct, live: after "Approve Plan A" on three options, the reply above the execution card still compared the plans
 * ("Plan B deploys ..., Plan C places ...") and never said which one was running. While a chosen plan runs, the
 * thread says so in one line; once the run ends the composed summary takes the place as before.
 */
const RUNNING = new Set(["approved", "running", "awaiting_signature"]);

export function runningPlan(opts: {
  status: string | null | undefined;
  candidateId: string | null | undefined;
  feasible: ReadonlyArray<{ id: string; label: string }> | null | undefined;
}): { letter: string; title: string } | null {
  const feasible = opts.feasible ?? [];
  // A single option has nothing to be told apart from.
  if (!opts.status || !RUNNING.has(opts.status) || !opts.candidateId || feasible.length < 2) return null;
  const index = feasible.findIndex((candidate) => candidate.id === opts.candidateId);
  return index < 0 ? null : { letter: String.fromCharCode(65 + index), title: feasible[index].label };
}

export function runningPlanText(plan: { letter: string; title: string }): string {
  const title = plan.title.trim().replace(/\.$/, "");
  return `Running Plan ${plan.letter}: ${title}.`;
}
