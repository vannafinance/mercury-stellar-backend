/** Client and server run clocks for one investigation, never time since mount. */
export function formatRunClock(seconds: number): string {
  const sec = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
}

export function formatElapsedMs(ms: number): string {
  return formatRunClock(Math.round(ms / 1000));
}
