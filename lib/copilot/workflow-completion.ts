import type { ExecutionReceiptSnapshot } from "./execution-receipt";
import type { ReplyBlock } from "./investigation/view";

/** Presentation only: settlement authority remains the workflow journal. */
export type WorkflowCompletion = {
  workflowId: string;
  receiptKey: string;
  generatedAt: number;
  source: "model" | "fallback";
};
export type WorkflowCompletionReply = {
  message: string;
  replyBlocks: ReplyBlock[];
  receipt: ExecutionReceiptSnapshot;
  completion: WorkflowCompletion;
};

/** A completed journal may still need a presentation-only restore to finish its summary. */
export function needsCompletionRecovery(receipt: ExecutionReceiptSnapshot | null | undefined,
  completion: WorkflowCompletion | null | undefined): boolean {
  return receipt?.status === "completed" && !completionMatches(receipt, completion);
}

/** A transaction hash for display: the ends, with the whole hash kept in the link's title and accessible name. */
export function shortTransactionHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

/**
 * The reply shown the moment a run settles, built only from the receipt: what was done, from the legs'
 * own labels, and that it settled. It carries the receipt's key, so it draws the same settled list the
 * model-worded reply does, and that reply replaces it when it arrives. Nothing here waits on a model.
 */
export function immediateCompletion(receipt: ExecutionReceiptSnapshot, now: number = Date.now()): WorkflowCompletionReply | null {
  const transactions = settledTransactions(receipt);
  if (!transactions) return null;
  const what = transactions.map((transaction) => transactionPurpose(transaction.steps)).join("; ").replace(/[.s]+$/, "");
  const message = `${what} - settled on-chain.`;
  return {
    message,
    // What was done reads as a bold figure, the way the model-worded reply sets it; the status follows plainly.
    replyBlocks: [{ type: "paragraph", segments: [{ text: what, figure: true }, { text: " - settled on-chain." }] }],
    receipt,
    completion: { workflowId: receipt.workflowId, receiptKey: receiptKey(receipt), generatedAt: now, source: "fallback" },
  };
}

/**
 * What a finished run needs next so that it always ends with a summary, decided from the run itself and from whether its turn already
 * carries a receipt. It does not depend on any other step having happened first (the receipt being saved, an effect having run in a
 * given order): a finished run whose turn has no receipt is given one built from the run, and one whose turn has a settled receipt is
 * composed. Waiting is only for a run that has not finished or has nothing settled.
 */
export function completionStep(
  run: { status: string },
  onTurn: ExecutionReceiptSnapshot | null | undefined,
  fromRun: () => ExecutionReceiptSnapshot | null,
): { kind: "wait" } | { kind: "attach"; receipt: ExecutionReceiptSnapshot } | { kind: "compose"; receipt: ExecutionReceiptSnapshot } {
  if (run.status !== "completed") return { kind: "wait" };
  if (onTurn && settledTransactions(onTurn)) return { kind: "compose", receipt: onTurn };
  const built = fromRun();
  return built && (!onTurn || built.workflowId === onTurn.workflowId) && settledTransactions(built)
    ? { kind: "attach", receipt: built } : { kind: "wait" };
}

/**
 * Where each transaction's hash and ledger can sit beside the reply's own words, instead of in a second list that says the same
 * thing again (7 Oct: "Deposited 5 XLM" above and "Deposit 5 XLM - hash - ledger" below).
 *
 * That is possible only when the reply has a list with exactly one item per settled transaction: the nth item then carries the nth
 * transaction, which is what the composer is told to write. Anything else (a sentence, a list of another length) returns null and
 * the verified list stays where it is, so the evidence of what settled is never dropped for the sake of tidiness.
 */
export function receiptBeside(blocks: ReadonlyArray<{ type: string; items?: readonly unknown[] }> | undefined, transactions: number): number | null {
  if (!blocks || transactions < 2) return null;
  const at = blocks.findIndex((block) => block.type === "bullets" && block.items?.length === transactions);
  return at >= 0 ? at : null;
}

export function receiptKey(receipt: ExecutionReceiptSnapshot): string {
  return JSON.stringify([receipt.workflowId, receipt.status, receipt.network,
    receipt.steps.map((s) => [s.operation, s.label ?? null, s.asset, s.amount, s.status, s.txHash ?? null, s.settledLedger ?? null])]);
}

export function explorerNetwork(network: string): "public" | "testnet" | null {
  if (network === "mainnet" || network === "public") return "public";
  return network === "testnet" ? "testnet" : null;
}

export function transactionPurpose(steps: ExecutionReceiptSnapshot["steps"]): string {
  return steps.map((step) => step.label || [step.operation, step.amount, step.asset].filter(Boolean).join(" ")).join("; ");
}

/** Plain history carries the same evidence as the UI; future turns need not parse a card. */
export function completionPlainText(message: string, receipt: ExecutionReceiptSnapshot): string {
  const transactions = settledTransactions(receipt);
  if (!transactions) return message;
  return `${message}\n\n${transactions.map((tx) => `- ${transactionPurpose(tx.steps)} · ${tx.url} · Ledger ${tx.ledger}`).join("\n")}`;
}

/** Require complete, internally consistent receipts before replacing recovery/progress UI. */
export function settledTransactions(receipt: ExecutionReceiptSnapshot) {
  const network = explorerNetwork(receipt.network);
  if (!network || receipt.status !== "completed" || !receipt.steps.length) return null;
  const groups = new Map<string, { hash: string; ledger: number; url: string; steps: ExecutionReceiptSnapshot["steps"] }>();
  for (const step of receipt.steps) {
    const hash = step.txHash?.toLowerCase();
    const ledger = step.settledLedger;
    if (step.status !== "settled" || !hash || hash.length !== 64 ||
      [...hash].some((c) => !"0123456789abcdef".includes(c)) ||
      !Number.isSafeInteger(ledger) || !ledger || ledger <= 0) return null;
    const group = groups.get(hash);
    if (group && group.ledger !== ledger) return null;
    if (group) group.steps.push(step);
    else groups.set(hash, { hash, ledger, url: `https://stellar.expert/explorer/${network}/tx/${hash}`, steps: [step] });
  }
  return [...groups.values()];
}

export function completionMatches(receipt: ExecutionReceiptSnapshot | null | undefined, completion: WorkflowCompletion | null | undefined): boolean {
  return !!receipt && !!completion && receipt.workflowId === completion.workflowId &&
    completion.receiptKey === receiptKey(receipt) && settledTransactions(receipt) !== null;
}

/** Never fall back to the newest turn: later user prompts can arrive during composition. */
export function applyWorkflowCompletion<T extends { role: string; executionReceipt?: ExecutionReceiptSnapshot | null }>(
  turns: readonly T[], reply: WorkflowCompletionReply,
): T[] | null {
  if (!completionMatches(reply.receipt, reply.completion) || !reply.message.trim() || !reply.replyBlocks.length) return null;
  const index = turns.findIndex((turn) => turn.role === "assistant" && turn.executionReceipt?.workflowId === reply.completion.workflowId);
  if (index < 0 || receiptKey(turns[index].executionReceipt!) !== reply.completion.receiptKey) return null;
  const updated = [...turns];
  updated[index] = { ...updated[index], text: reply.message, blocks: reply.replyBlocks,
    executionReceipt: reply.receipt, completion: reply.completion };
  return updated;
}
