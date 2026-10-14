/** Copy and continuation authority are tied to the actual setup action, never response wording. */
export const MISSING_MARGIN_ACCOUNT_NOTE = "No active margin account was discovered for this wallet.";

export interface AccountSetupContinuation {
  wallet: string;
  conversationId: string;
  request: string;
  setupRequestId: string | null;
}

/** Preserve the user's complete instruction, including later answers and constraints. */
export function accountSetupPrompt(view: { originalRequest: string; refinements: readonly string[] }): string {
  return [view.originalRequest, ...view.refinements].map(message => message.trim()).filter(Boolean).join("\n\n");
}

export function accountSetupRequest(
  pending: AccountSetupContinuation | null,
  context: { wallet: string | null; conversationId: string | null; setupRequestId: string | null; operation: string | null; cancelled: boolean; settled: boolean },
): string | null {
  if (!pending || !pending.setupRequestId || !context.settled || context.cancelled || context.operation !== "create_account"
    || pending.wallet !== context.wallet || pending.conversationId !== context.conversationId
    || pending.setupRequestId !== context.setupRequestId) return null;
  return pending.request.trim() || null;
}

export function lifecycleCompletionText(operation: string | null | undefined): string | null {
  if (operation === "create_account") return "Your margin account is open";
  if (operation === "settle_account") return "Your margin account is settled";
  return null;
}
