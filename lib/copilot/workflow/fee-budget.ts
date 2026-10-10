import { Transaction } from "@stellar/stellar-sdk";
import { HORIZON_URL } from "@/lib/stellar-utils";
import { decimalWad, formatWad, WAD, ZERO } from "../investigation/fixed";
import { isRecord } from "../investigation/decision";
import { ResearchError } from "../investigation/scope";
import { OP_FLOW, type ProposalStep, type WorkflowProposal } from "./types";
import { assertSigningTime } from "./signing-envelope";

/** Use the prepared envelope's full maximum fee, not a fixed reserve hint. */
export function assertNativeFeeBudget(tx: Transaction, step: ProposalStep, account: unknown, ledger: unknown,
  reserves: WorkflowProposal["walletReserves"] = []) {
  const unread = () => new ResearchError("fee_balance_unavailable", "The wallet balance and network reserve could not be verified for this transaction. Nothing was submitted. Try Sign in wallet again.", 503);
  if (!isRecord(account) || account.account_id !== tx.source || !Array.isArray(account.balances)
      || !isRecord(ledger)) throw unread();
  const native = account.balances.find(row => isRecord(row) && row.asset_type === "native");
  const counts = [account.subentry_count, account.num_sponsoring, account.num_sponsored];
  if (!isRecord(native) || counts.some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      || typeof ledger.base_reserve_in_stroops !== "number" || !Number.isSafeInteger(ledger.base_reserve_in_stroops)
      || ledger.base_reserve_in_stroops <= 0 || typeof native.balance !== "string"
      || typeof native.selling_liabilities !== "string") throw unread();
  let balance: bigint, liabilities: bigint, debit: bigint, fee: bigint;
  try {
    balance = decimalWad(native.balance); liabilities = decimalWad(native.selling_liabilities);
    debit = OP_FLOW[step.op].from === "wallet" && step.asset === "XLM" ? decimalWad(step.amount) : ZERO;
    // Stellar envelope fees and ledger reserves are denominated in stroops.
    fee = BigInt(tx.fee) * WAD / BigInt(10_000_000);
  } catch { throw unread(); }
  if (balance < ZERO || liabilities < ZERO || debit < ZERO || fee < ZERO) throw unread();
  const [subentries, sponsoring, sponsored] = counts as number[];
  const entries = 2 + subentries + sponsoring - sponsored;
  if (entries < 0) throw unread();
  const minimum = BigInt(entries) * BigInt(ledger.base_reserve_in_stroops) * WAD / BigInt(10_000_000);
  const available = balance - liabilities - minimum - debit;
  if (available < fee) {
    const gap = fee - available;
    throw new ResearchError("insufficient_transaction_fee", `This transaction needs up to ${formatWad(fee)} XLM in fees, but only ${formatWad(available > ZERO ? available : ZERO)} XLM is available after the network minimum balance and this step. Add at least ${formatWad(gap)} XLM to the wallet before signing again. Nothing was submitted.`, 409);
  }
  // The network minimum is locked capital. A user-owned liquid reserve is additional
  // spendable capital and must survive even when the full envelope fee is charged.
  let liquid = ZERO;
  try {
    for (const reserve of reserves ?? []) if (reserve.asset === "XLM") {
      const amount = decimalWad(reserve.amount);
      if (amount > liquid) liquid = amount;
    }
  } catch { throw unread(); }
  if (available - fee < liquid) {
    const gap = liquid + fee - available;
    throw new ResearchError("wallet_reserve_fee_shortfall", `Keeping ${formatWad(liquid)} XLM liquid after this step and up to ${formatWad(fee)} XLM in fees needs another ${formatWad(gap)} XLM in the wallet. Add that fee funding before signing again, or request and approve a smaller plan. The approved amounts were not changed. Nothing was submitted.`, 409);
  }
}

/** Focused native-account reads; no MCP write, signing, or balance mutation. */
export async function checkTransactionFee(xdr: string, step: ProposalStep, request: typeof fetch = fetch,
  reserves: WorkflowProposal["walletReserves"] = []) {
  const tx = assertSigningTime(xdr);
  const [account, ledgers] = await Promise.all([
    request(`${HORIZON_URL}/accounts/${tx.source}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) }),
    request(`${HORIZON_URL}/ledgers?order=desc&limit=1`, { cache: "no-store", signal: AbortSignal.timeout(15_000) }),
  ]);
  if (!account.ok || !ledgers.ok) throw new ResearchError("fee_balance_unavailable", "The wallet fee balance could not be verified. Nothing was submitted. Try Sign in wallet again.", 503);
  const [accountData, ledgerData] = await Promise.all([account.json(), ledgers.json()]);
  const latest = isRecord(ledgerData) && isRecord(ledgerData._embedded) && Array.isArray(ledgerData._embedded.records)
    ? ledgerData._embedded.records[0] : null;
  assertNativeFeeBudget(tx, step, accountData, latest, reserves);
}
