/**
 * Exact-match read cache. Shared by the investigation fast-path and by
 * `routeMessage`, so keyword routing cannot invent a second planner for
 * questions the page already knows how to answer.
 *
 * Anything with a write/plan clause returns null and falls through.
 */

import { allAssets, resolveAsset, type AssetId } from "../registry/assets";

const WRITE_OR_PLAN =
  /\b(swap|lend|borrow|deposit|repay|farm|invest|supply|withdraw|redeem|allocate|park|deploy|strategy|rebalance|then|and also|if\b|unless|whenever|monitor|watch my|every day)\b/i;

const HEALTH_ASK =
  /^(?:hey[, ]+|hi[, ]+|hello[, ]+)?(?:what(?:'s| is)|whats|show(?: me)?|tell me|how(?:'s| is)|check)\s+(?:my\s+)?(?:health(?:\s+factor)?|hf)\b|\bam i (?:safe|at risk|close to liquidation)\b|\b(?:my )?health factor\b\??$/i;

const PRICE_ASK =
  /\b(?:price|oracle|worth|trading at|value)\b/i;

const WITHDRAW_ELIGIBILITY =
  /\b(can i|could i|may i|is it (?:ok|safe)|without (?:getting )?liquidat|would .{0,40}liquidat|allowed to)\b/i;

const MULTI_CLAUSE =
  /\b(then|and also|swap|lend|borrow|repay|farm|deposit|redeem)\b/i;

function onlyAsset(text: string): AssetId | null {
  const named = allAssets().filter((asset) => {
    const re = new RegExp(`(?:^|[^A-Z0-9])${asset.id}(?:[^A-Z0-9]|$)`, "i");
    return re.test(text) || asset.aliases.some((alias) => {
      if (/\s/.test(alias)) return false;
      return new RegExp(`(?:^|[^A-Z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^A-Z0-9]|$)`, "i").test(text);
    });
  });
  if (named.length !== 1) return null;
  const match = resolveAsset(named[0].id);
  return match.kind === "asset" ? match.def.id : null;
}

export type FastPathMatch =
  | { kind: "health" }
  | { kind: "price"; asset: AssetId };

export function matchFastPath(message: string): FastPathMatch | null {
  const text = message.trim();
  if (!text || text.length > 120 || WRITE_OR_PLAN.test(text)) return null;
  const compact = text.toLowerCase().replace(/\s+/g, " ");
  if (HEALTH_ASK.test(compact) && !PRICE_ASK.test(compact)) return { kind: "health" };
  if (PRICE_ASK.test(compact)) {
    const asset = onlyAsset(text);
    if (asset) return { kind: "price", asset };
  }
  return null;
}

/**
 * Eligibility-only withdraw: "can I withdraw 100 XLM without getting liquidated?"
 * A command ("withdraw 100 XLM") or a second write clause falls through.
 */
export function parseWithdrawCheck(message: string): { asset: AssetId; amount: string } | null {
  const text = message.trim();
  if (!text || text.length > 160) return null;
  if (MULTI_CLAUSE.test(text)) return null;
  const match = text.match(/\bwithdraw\s+(\d+(?:\.\d{1,18})?)\s+(XLM|BLUSDC|AQUSDC|SOUSDC)\b/i);
  if (!match) return null;
  if (!WITHDRAW_ELIGIBILITY.test(text) && !/\?\s*$/.test(text)) return null;
  return { amount: match[1], asset: match[2].toUpperCase() as AssetId };
}
