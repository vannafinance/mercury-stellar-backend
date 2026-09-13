import { NETWORK_PASSPHRASE } from "@/lib/stellar-utils";
import { copilotConfig } from "@/lib/copilot/config";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export type ResearchConfig =
  | { ok: true; secret: string; network: "testnet" }
  | { ok: false; status: number; code: string; message: string };

/**
 * Single research-availability gate. Network comes from NETWORK_PASSPHRASE —
 * never from a second env var that can disagree with the Stellar client.
 */
export function researchConfig(): ResearchConfig {
  if (process.env.COPILOT_RESEARCH_ENABLED === "false") {
    console.warn("[copilot] research disabled via COPILOT_RESEARCH_ENABLED");
    return {
      ok: false,
      status: 503,
      code: "research_disabled",
      message: "Investigation is disabled on this deployment (COPILOT_RESEARCH_ENABLED=false).",
    };
  }
  const secret = process.env.COPILOT_RESEARCH_SECRET?.trim() || copilotConfig.sessionSecret;
  if (secret.length < 32) {
    return {
      ok: false,
      status: 503,
      code: "research_not_configured",
      message: "Investigation is not available on this deployment yet.",
    };
  }
  if (NETWORK_PASSPHRASE !== TESTNET_PASSPHRASE) {
    return {
      ok: false,
      status: 503,
      code: "research_not_configured",
      message: "Investigation is only available on testnet.",
    };
  }
  return { ok: true, secret, network: "testnet" };
}
