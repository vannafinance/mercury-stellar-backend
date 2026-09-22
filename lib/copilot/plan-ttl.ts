/**
 * Waiting to Approve is not a quote timeout. Swap re-quotes on submit; Earn, Farm and
 * Margin re-read live funds on Approve. This TTL only retires a proposal nobody clicked.
 */
export const PLAN_TTL_MS = 24 * 60 * 60_000;
