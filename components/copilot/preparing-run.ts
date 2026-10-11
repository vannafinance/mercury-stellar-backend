/**
 * An action the app approves on the user's behalf has no plan card (owner, 24 Sep and 8 Oct): a stated action is
 * prepared and approved on its own, and a strategy plan the user has just approved is already approved, so the
 * execution card shows it running in both cases. Between "prepared" and "approved" the journal still reads "proposed"
 * for as long as the live check takes (about 13 s, 8 Oct), and that state used to draw the Plan for
 * approval card with a disabled button, a second approval screen for something already approved.
 *
 * So while the app is the one approving, the execution card stands in. A plan nobody has approved keeps its
 * card, a swap keeps its own review, a withdrawn plan says so, and a plan whose approval failed (nothing in
 * flight, nothing about to start) shows its Approve again so the user can retry.
 */
export function preparingStatedRun(opts: {
  /** The app approves this plan itself: a stated action, or a plan the user pressed Approve on. */
  approvedByApp: boolean;
  status: string;
  hasSwap: boolean;
  withdrawn: boolean;
}): boolean {
  return opts.approvedByApp && opts.status === "proposed" && !opts.hasSwap && !opts.withdrawn;
}
