/**
 * Which plan is running, for the line above the execution card.
 *
 * 8 Oct, live: after "Approve Plan A" on three options, the reply above the execution card still compared the plans
 * ("Plan B deploys ..., Plan C places ...") and never said which one was running. While a chosen plan runs, the
 * thread says so in one line; once the run ends the composed summary takes the place as before.
 */
const RUNNING = new Set(["approved", "running", "awaiting_signature", "completed"]);

export function runningPlan(opts: {
  status: string | null | undefined;
  candidateId: string | null | undefined;
  workflowCandidateId?: string | null;
  feasible: ReadonlyArray<{ id: string; label: string }> | null | undefined;
}): { letter: string; title: string } | null {
  const feasible = opts.feasible ?? [];
  const candidateId = opts.workflowCandidateId ?? opts.candidateId;
  if (!opts.status || !RUNNING.has(opts.status) || !candidateId || !feasible.length) return null;
  const index = feasible.findIndex((candidate) => candidate.id === candidateId);
  return index < 0 ? null : { letter: String.fromCharCode(65 + index), title: feasible[index].label };
}

export function runningPlanText(plan: { letter: string; title: string }, completed = false): string {
  const title = plan.title.trim().replace(/\.$/, "");
  return `${completed ? "Completed" : "Running"} Plan ${plan.letter}: ${title}.`;
}
