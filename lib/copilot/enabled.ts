/**
 * Single kill switch for every Copilot entry point (nav link, floating launcher,
 * /copilot page, /api/copilot* routes). Defaults OFF — set
 * NEXT_PUBLIC_COPILOT_ENABLED="true" in the environment to bring it back.
 *
 * NEXT_PUBLIC_ so the same value is readable client-side (nav/launcher) and
 * server-side (route guards) without keeping two flags in sync.
 */
export function isCopilotEnabled(): boolean {
  return process.env.NEXT_PUBLIC_COPILOT_ENABLED === "true";
}
