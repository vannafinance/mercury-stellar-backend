/** Product retention policy. Pinned chats and unresolved workflows are exempt. */
export const CHAT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const RECENT_CHAT_LIMIT = 30;

export function retainedChatList<T extends { updatedAt: number; pinned?: boolean; pending?: boolean }>(items: readonly T[], now = Date.now()): T[] {
  let ordinary = 0;
  return [...items].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
    .filter((item) => item.pinned || item.pending || (now - item.updatedAt < CHAT_RETENTION_MS && ordinary++ < RECENT_CHAT_LIMIT));
}
