"use client";

import { copilotRequestHeaders } from "@/lib/copilot/copilot-request";
import { withClientDeadline } from "@/lib/copilot/client-deadline";
import type { ReplyBlock } from "@/lib/copilot/investigation/view";

/**
 * Ask the server to word a finished run's reply around the run's own facts. The browser sends
 * only the run id and the sealed research continuation; every figure is the server's. Null
 * (204, an error, or a timeout) keeps the "Done." reply already on screen.
 */
export async function fetchComposedCompletion(
  workflowId: string,
  continuation: string | null,
  signal: AbortSignal,
): Promise<{ message: string; replyBlocks: ReplyBlock[] } | null> {
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    const headers = await withClientDeadline(copilotRequestHeaders(), deadline);
    const response = await fetch(`/api/copilot/workflow/${workflowId}/reply`, {
      method: "POST", headers, signal: deadline, cache: "no-store",
      body: JSON.stringify(continuation ? { continuation } : {}),
    });
    if (response.status !== 200) return null;
    const payload = await response.json() as { message?: unknown; replyBlocks?: unknown };
    return typeof payload.message === "string" && Array.isArray(payload.replyBlocks) && payload.replyBlocks.length
      ? { message: payload.message, replyBlocks: payload.replyBlocks as ReplyBlock[] }
      : null;
  } catch {
    return null;
  }
}
