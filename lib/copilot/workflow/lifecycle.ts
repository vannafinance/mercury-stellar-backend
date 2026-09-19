/**
 * Writes that are not plans. They spend no token amount and are not composed by the
 * sizer — the connected G-wallet is the only input. Kept off `WORKFLOW_OPS` so the
 * shape matrix and journal never treat them as sized legs.
 */
export const LIFECYCLE_WRITES = ["create_account"] as const;
export type LifecycleWriteOp = (typeof LIFECYCLE_WRITES)[number];

export function isLifecycleWriteOp(value: string): value is LifecycleWriteOp {
  return (LIFECYCLE_WRITES as readonly string[]).includes(value);
}

/**
 * A lifecycle write is accepted only when the model named an op from this list and
 * quoted the user's own message. Sized actions or plans beside it win: opening the
 * account cannot share a turn with a step that spends it.
 */
export function anchoredLifecycleWrite(
  write: { op: string; sourceQuote: string } | undefined,
  messages: readonly string[],
  hasSizedWork: boolean,
): LifecycleWriteOp | null {
  if (hasSizedWork || !write || !isLifecycleWriteOp(write.op)) return null;
  if (!write.sourceQuote || !messages.some((message) => message.includes(write.sourceQuote))) return null;
  return write.op;
}
