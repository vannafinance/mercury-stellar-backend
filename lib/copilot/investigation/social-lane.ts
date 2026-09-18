/**
 * Leftover greeting lane. Product turns never enter this file's Vertex call.
 *
 * A serial Flash classify in front of every investigate/lend turn would add
 * seconds. This only runs when the cheap domain firewall did not already see
 * product vocabulary (and is not the greeting cheap-allow, which exists so "hi"
 * is not refused — it is not a product request). Mixed "hi, lend 10 XLM" is
 * product and falls through untouched.
 *
 * Model: VERTEX_SOCIAL_MODEL (default gemini-3.5-flash-lite), MINIMAL thinking,
 * hard 2s abort. Timeout/error is not an investigation: that was the original
 * "hi" costing half a minute. Work-classified leftovers still hit the firewall.
 */

import { abuseTripwire, evaluateDomainFirewall, SELF_REFERENTIAL } from "../domain-firewall";
import { ASSET_DOMAIN_WORDS } from "../registry/assets";
import { generateSocialLaneJson } from "../vertex";
import { isRecord } from "./decision";

const ASSET_TICKERS = new Set(ASSET_DOMAIN_WORDS);

export const SOCIAL_LANE_TIMEOUT_MS = 2_000;

const SOCIAL_SYSTEM = `You sort one user message for the Vanna Finance copilot on Stellar.
lane=social only when the message is a greeting or asking who/what this copilot is, with no Earn, Farm, Margin, wallet, swap, health, pool, or size/amount request.
lane=work when there is any product task, including a greeting attached to one (example: a hi plus a lend or borrow).
When lane=social, reply in 1-3 short sentences as Vanna Copilot. Invite a margin, Earn, Farm, or live-sized move. No APYs, balances, addresses, or contract ids.
When lane=work, reply must be empty.
Return only JSON.`;

export type SocialLaneResult = {
  lane: "social" | "work";
  reply: string;
};

export function isGreetingOrIdentityLeftover(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  const verdict = evaluateDomainFirewall(text);
  if (verdict.reason === "allow:greeting") return true;
  return SELF_REFERENTIAL.some((re) => re.test(text));
}

export function isProductInvestigationTurn(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (abuseTripwire(text)) return false;
  if (isGreetingOrIdentityLeftover(text)) return false;
  const verdict = evaluateDomainFirewall(text);
  if (!verdict.allow) return false;
  // "heyy" / "yo" cheap-allow as short_token. Only a known asset ticker is a product turn.
  if (verdict.reason === "allow:short_token") {
    return ASSET_TICKERS.has(text.replace(/\?+$/, "").toLowerCase());
  }
  return true;
}

export async function classifySocialLane(
  message: string,
  signal?: AbortSignal,
): Promise<SocialLaneResult | null> {
  const text = message.trim();
  if (!text) return null;
  const budget = AbortSignal.timeout(SOCIAL_LANE_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, budget]) : budget;
  try {
    const raw = await generateSocialLaneJson(
      SOCIAL_SYSTEM,
      JSON.stringify({ message: text.slice(0, 500) }),
      combined,
    );
    if (!isRecord(raw) || (raw.lane !== "social" && raw.lane !== "work")) return null;
    const reply = typeof raw.reply === "string" ? raw.reply.trim().slice(0, 600) : "";
    if (raw.lane === "social" && !reply) return null;
    return { lane: raw.lane, reply: raw.lane === "social" ? reply : "" };
  } catch {
    return null;
  }
}
