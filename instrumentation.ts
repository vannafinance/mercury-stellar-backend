/**
 * Next.js 16 instrumentation hook (stable since 15; no experimental flag).
 * NodeSDK is not compatible with Edge — only load it on the Node runtime.
 * Copilot routes already set `runtime = "nodejs"`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}
