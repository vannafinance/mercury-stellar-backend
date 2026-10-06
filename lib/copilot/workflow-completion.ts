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
