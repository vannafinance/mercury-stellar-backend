import { StrKey } from "@stellar/stellar-sdk";
import { MarginAccountService } from "@/lib/margin-utils";
import type { MCPClient } from "../mcp-client";
import { claimedSet, isUsable, type ReadResult } from "@/lib/usable-read";
import { isRecord } from "./decision";
import { interruptible } from "./runtime";
import type { InvestigationScope } from "./types";

export class ResearchError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

export const SCOPE_CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { scope: InvestigationScope; expiresAt: number };

const scopeCache = new Map<string, CacheEntry>();

function cacheKey(input: { subject: string; wallet: string | null; network: string }): string {
  return `${input.subject}\0${input.wallet ?? ""}\0${input.network}`;
}

export function resetInvestigationScopeCache(): void {
  scopeCache.clear();
}

function remember(
  input: { subject: string; wallet: string | null; network: string },
  scope: InvestigationScope,
): InvestigationScope {
  // Only verified scopes (a trader was established). Caching an empty-bindings
  // public fallback for five minutes would hide a later good binding.
  if (scope.trader && !scope.unverified) {
    scopeCache.set(cacheKey(input), { scope, expiresAt: Date.now() + SCOPE_CACHE_TTL_MS });
  }
  return scope;
}

function publicScope(
  input: { subject: string; network: string },
  unverified?: "bindings",
): InvestigationScope {
  return {
    subject: input.subject, trader: null, smartAccount: null, network: input.network,
    ...(unverified ? { unverified } : {}),
  };
}

function bindingAddress(row: Record<string, unknown>): unknown {
  return row.walletAddress ?? row.wallet_address;
}

function walletsFromBindings(
  bound: Record<string, unknown>,
  subject: string,
): ReadResult<readonly string[]> {
  if (bound.error || bound.has_assertion !== true || bound.sub !== subject || !Array.isArray(bound.bindings)) {
    return { ok: false, reason: "bindings_unverified" };
  }
  const wallets = bound.bindings.filter(isRecord).filter((row) =>
    row.revoked !== true && !row.revokedAt && !row.revoked_at && row.active !== false,
  ).map(bindingAddress).filter((wallet): wallet is string =>
    typeof wallet === "string" && StrKey.isValidEd25519PublicKey(wallet),
  );
  return claimedSet(wallets, "bindings_empty");
}

async function readBindings(
  mcp: Pick<MCPClient, "call">,
  signal: AbortSignal,
  subject: string,
  wallet: string | null,
): Promise<ReturnType<typeof walletsFromBindings>> {
  const call = () => interruptible(() => mcp.call("vanna_list_my_wallet_bindings", {}), signal);
  const first = await call();
  const parsed = walletsFromBindings(first, subject);
  console.info("[copilot] investigation scope bindings", {
    raw: first,
    wallets: parsed.ok ? parsed.value : [],
    reason: parsed.ok ? undefined : parsed.reason,
    wallet,
  });
  if (parsed.ok) return parsed;
  const retry = await call();
  const retried = walletsFromBindings(retry, subject);
  console.info("[copilot] investigation scope bindings retry", {
    raw: retry,
    wallets: retried.ok ? retried.value : [],
    reason: retried.ok ? undefined : retried.reason,
    wallet,
  });
  return retried;
}

async function resolveSmartAccount(
  mcp: Pick<MCPClient, "call">,
  signal: AbortSignal,
  trader: string,
): Promise<string | null> {
  const call = () => interruptible(() => mcp.call("vanna_resolve_account", { trader }, trader), signal);
  let resolved: Record<string, unknown>;
  try {
    resolved = await call();
  } catch (error) {
    console.warn("[copilot] investigation scope resolve threw", {
      trader,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    resolved = { error: "resolve_threw" };
  }
  if (resolved.error) {
    try {
      resolved = await call();
    } catch (error) {
      console.warn("[copilot] investigation scope resolve retry threw", {
        trader,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
      resolved = { error: "resolve_threw" };
    }
  }
  console.info("[copilot] investigation scope resolve", {
    trader,
    status: resolved.status ?? null,
    error: resolved.error ?? null,
    smart_account: typeof resolved.smart_account === "string" ? resolved.smart_account : null,
  });
  const account = resolved.smart_account;
  if (typeof account === "string" && StrKey.isValidContract(account) &&
    ["found_on_chain", "found"].includes(String(resolved.status))) {
    return account;
  }
  if (account == null && ["required", "has_inactive"].includes(String(resolved.status))) {
    return null;
  }
  // MCP did not verify. Same on-chain discovery the account panel uses.
  try {
    const discovered = await interruptible(
      () => MarginAccountService.discoverExistingAccount(trader),
      signal,
    );
    console.info("[copilot] investigation scope chain fallback", { trader, discovered });
    if (typeof discovered === "string" && StrKey.isValidContract(discovered)) return discovered;
  } catch (error) {
    console.warn("[copilot] investigation scope chain fallback failed", {
      trader,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
  }
  if (resolved.error) {
    throw new ResearchError("account_unavailable", "I couldn't read the wallet's margin-account association. Try again when account data is available.");
  }
  throw new ResearchError("account_unverified", "The account response couldn't be verified. No account was selected.");
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
    return publicScope(input);
  }
  const cached = scopeCache.get(cacheKey(input));
  if (cached && cached.expiresAt > Date.now()) return cached.scope;

  const bound = await readBindings(mcp, signal, input.subject, input.wallet);
  if (!isUsable(bound)) {
    // Empty or malformed: could not verify. Never accuse the wallet of being unlinked.
    return publicScope(input, "bindings");
  }
  const unique = [...new Set(bound.value)];
  if (input.wallet && !unique.includes(input.wallet)) {
    throw new ResearchError("wallet_not_bound", "This wallet isn't linked to your signed-in account. Link it in wallet settings before investigating its positions.");
  }
  if (!input.wallet && unique.length > 1) throw new ResearchError("choose_wallet", "Choose the connected wallet you want me to investigate.");
  const trader = input.wallet ?? unique[0] ?? null;
  if (!trader) return publicScope(input, "bindings");
  const smartAccount = await resolveSmartAccount(mcp, signal, trader);
  return remember(input, { subject: input.subject, trader, smartAccount, network: input.network });
}
