import { StrKey } from "@stellar/stellar-sdk";
import type { MCPClient } from "../mcp-client";
import { isRecord } from "./decision";
import { interruptible } from "./runtime";
import type { InvestigationScope } from "./types";

export class ResearchError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

/** Only verified bindings can select a wallet; never forward a provided C-address. */
export async function resolveInvestigationScope(
  input: { subject: string; wallet: string | null; network: string },
  mcp: Pick<MCPClient, "call">,
  signal: AbortSignal,
): Promise<InvestigationScope> {
  if (input.wallet && !StrKey.isValidEd25519PublicKey(input.wallet)) {
    throw new ResearchError("invalid_wallet", "Choose a valid connected Stellar wallet.", 400);
  }
  /**
   * Public and conceptual questions need no account. Requiring a binding here
   * dropped "explain what a health factor is" for anyone without a linked wallet,
   * including signed-out visitors. Guest identity never has bindings to check.
   */
  if (!input.wallet || input.subject === "guest") {
    return { subject: input.subject, trader: null, smartAccount: null, network: input.network };
  }
  const bound = await interruptible(() => mcp.call("vanna_list_my_wallet_bindings", {}), signal);
  if (bound.error || bound.has_assertion !== true || bound.sub !== input.subject || !Array.isArray(bound.bindings)) {
    // Bindings prove identity, not whether the prompt is answerable. Falling back to
    // public scope lets a conceptual question complete instead of dying as "couldn't reach".
    return { subject: input.subject, trader: null, smartAccount: null, network: input.network };
  }
  const wallets = bound.bindings.filter(isRecord).filter((row) =>
    row.revoked !== true && !row.revokedAt && !row.revoked_at && row.active !== false,
  ).map((row) => row.walletAddress).filter((wallet): wallet is string =>
    typeof wallet === "string" && StrKey.isValidEd25519PublicKey(wallet),
  );
  const unique = [...new Set(wallets)];
  if (input.wallet && !unique.includes(input.wallet)) {
    throw new ResearchError("wallet_not_bound", "This wallet isn't linked to your signed-in account. Link it in wallet settings before investigating its positions.");
  }
  if (!input.wallet && unique.length > 1) throw new ResearchError("choose_wallet", "Choose the connected wallet you want me to investigate.");
  const trader = input.wallet ?? unique[0] ?? null;
  if (!trader) return { subject: input.subject, trader: null, smartAccount: null, network: input.network };
  const resolved = await interruptible(() => mcp.call("vanna_resolve_account", { trader }, trader), signal);
  if (resolved.error) throw new ResearchError("account_unavailable", "I couldn't read the wallet's margin-account association. Try again when account data is available.");
  const account = resolved.smart_account;
  if (typeof account === "string" && StrKey.isValidContract(account) &&
    ["found_on_chain", "found"].includes(String(resolved.status))) {
    return { subject: input.subject, trader, smartAccount: account, network: input.network };
  }
  if (account == null && ["required", "has_inactive"].includes(String(resolved.status))) {
    return { subject: input.subject, trader, smartAccount: null, network: input.network };
  }
  throw new ResearchError("account_unverified", "The account response couldn't be verified. No account was selected.");
}
