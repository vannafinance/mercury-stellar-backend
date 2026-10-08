/**
 * A stated action has no plan card (owner, 24 Sep): it is prepared and approved on its own and the
 * execution card shows it running. Between "prepared" and "approved" the journal still reads
 * `proposed` for as long as the live check takes (about 13 s, 8 Oct), and that state used to draw the
 * Plan for approval card with a disabled button, which is the plan card the owner ruled out.
 *
 * So for a stated action the execution card stands in while the approval is being prepared. Everything
 * else keeps its card: a strategy the model chose is the user's to approve, a swap keeps its review,
 * a withdrawn plan says so, and a stated action whose approval failed (nothing in flight, nothing about
 * to start) shows its Approve again so the user can retry.
 */
export function preparingStatedRun(opts: {
  /** The reply's own plan is the user's stated action (REQUESTED_ACTIONS_ID), not a strategy option. */
  stated: boolean;
  status: string;
  hasSwap: boolean;
  withdrawn: boolean;
  /** A request about this plan is in flight. */
  busy: boolean;
  /** The workspace has this plan queued for approval and has not sent it yet. */
  approvalQueued: boolean;
}): boolean {
  return opts.stated && opts.status === "proposed" && !opts.hasSwap && !opts.withdrawn && (opts.busy || opts.approvalQueued);
}
