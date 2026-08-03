/**
 * LLM domain firewall — hard boundary so Vanna Copilot/MCP only burns
 * model tokens on Vanna Finance / Stellar DeFi product work.
 *
 * Why: open-ended chatbots get used for free coding/homework and rack up
 * Vertex/LLM bills (classic support-bot abuse). Firewall runs BEFORE Vertex.
 *
 * Layers:
 *  1) Fast blocklist (coding, homework, unrelated)
 *  2) Allowlist (product domain signals)
 *  3) Soft allow when ambiguous short product questions
 *  4) Systems prompts still restate domain (defense in depth)
 */

export type FirewallResult =
  | { allow: true; reason: string }
  | { allow: false; reason: string; message: string };

const BLOCK_MESSAGE =
  "I only help with Vanna Finance on Stellar — Earn, Farm, Margin, wallet connect, " +
  "swaps, health factor, and related product questions.\n\n" +
  "I can’t help with general coding, homework, or unrelated chat. " +
  "Try something like “what’s my health factor?”, “lend 10 XLM”, or " +
  "“park 20 XLM then farm 10 BLUSDC at 2x”.";

/** Clear off-domain abuse vectors (billing / policy). */
const BLOCK_PATTERNS: RegExp[] = [
  // Coding / software engineering free work (billing abuse)
  /\b(write|generate|debug|fix|implement|refactor|code\s+review)\b.+\b(code|function|class|script|program|api|endpoint)\b/i,
  /\b(python|javascript|typescript|java|golang|rust|c\+\+|react|next\.js|django|flask|sql query)\b/i,
  /\b(leetcode|hackerrank|coding\s+interview|solve\s+this\s+problem|coding\s+challenge)\b/i,
  /\b(write\s+(me\s+)?a\s+(function|class|script|program|regex|dockerfile|kubernetes|app|website|bot))\b/i,
  /\b(help\s+me\s+(code|program|debug|build\s+(an?\s+)?(app|website|api)))\b/i,
  /\b(github\s+actions|ci\/cd|terraform|ansible|npm\s+install|pip\s+install)\b/i,
  /\b(stack\s*overflow|copy\s+paste\s+code|boilerplate)\b/i,
  // Homework / essays / general AI abuse
  /\b(write\s+(me\s+)?(an?\s+)?(essay|homework|assignment|thesis|paper|cover\s+letter|resume)\b)/i,
  /\b(do\s+my\s+homework|solve\s+this\s+math|calculus|integral|derivative|physics\s+problem)\b/i,
  // Unrelated life / entertainment
  /\b(recipe|cook|dating|horoscope|joke|poem|song\s+lyrics|movie\s+plot|netflix)\b/i,
  /\b(crypto\s+scam|how\s+to\s+(hack|phish|exploit)\b)/i,
  // Other chains as coding help
  /\b(solidity|smart\s+contract\s+code|metamask\s+dapp)\b.+\b(write|code|implement)\b/i,
  /\b(write|implement|code)\b.+\b(solidity|ethereum\s+contract)\b/i,
];

/**
 * Questions about the surface the user is on.
 *
 * Every page in this app is a Vanna product page, so "what am I looking at?" is a
 * product question no matter how it is phrased — it was being refused because the old
 * screen pattern only matched "what is / what are", and the way people actually ask is
 * "what am I looking at on this page?". A refusal here is the worst possible answer:
 * the Assistant's whole pitch is that it reads the page.
 */
const PAGE_REFERENTIAL: RegExp[] = [
  /\b(this|the|current)\s+(page|screen|tile|panel|card|section|view|number|figure|chart|table|column|row)\b/i,
  /\b(what|where)\s+am\s+i\b/i,
  /\b(looking\s+at|on\s+screen|on\s+my\s+screen|shown\s+here|right\s+here)\b/i,
  /\b(what|how)\s+does\s+(this|that|it)\b/i,
  /\b(what|who)\s+(is|are)\s+(this|that|these|those)\b/i,
  /\b(explain|walk\s+me\s+through|describe)\s+(this|the\s+page|the\s+screen|what)\b/i,
];

/** Strong in-domain signals for Vanna Finance. */
const ALLOW_PATTERNS: RegExp[] = [
  ...PAGE_REFERENTIAL,
  /\b(vanna|stellar|soroban|freighter|privy)\b/i,
  /\b(earn|farm|margin|lend|borrow|repay|deposit|redeem|collateral|health\s*factor|\bhf\b)\b/i,
  /\b(blend|aquarius|soroswap|xlm|blusdc|aqusdc|sousdc|btoken|vtoken)\b/i,
  /\b(swap|liquidity|pool|apy|tvl|leverage|liquidat|smart\s+account|g-?wallet|c-?address)\b/i,
  /\b(auto[- ]?sign|auto[- ]?approve|wallet\s+connect|open\s+(margin\s+)?account)\b/i,
  /\b(create|connect|setup|set\s*up|make|get|link)\b.+\b(wallet|g-?wallet|vanna\s+wallet|freighter|privy)\b/i,
  /\b(wallet|g-?wallet|freighter|privy)\b/i,
  /\b(what(?:'s| is| are).+\b(on\s+(my\s+)?screen|this\s+page|shown|showing)\b)/i,
  /\b(how\s+(do|does|can|to).+\b(vanna|earn|farm|margin|lend|borrow|deposit|swap)\b)/i,
  // "owe" is how users actually ask about debt — without it, "how much do I owe?"
  // fell through to the off-domain question block at step 5 and was refused.
  /\b(park|supply|withdraw|position|debt|owe|owes|owed|owing|balance|oracle|price)\b/i,
  // Multi-leg strategy language when tied to assets/actions above often co-occurs
  /\b(then|and\s+then).+\b(farm|lend|borrow|deposit|swap|repay)\b/i,
];

/**
 * A word that only means something in front of a page.
 *
 * With a captured page attached, a question containing one of these is about what the
 * user is looking at, so it is in-domain even without a product noun. Without one it
 * decides nothing: "what is the capital of France?" still gets refused whether or not
 * the drawer had a page, which is what keeps this from becoming an open chatbot.
 */
const DEICTIC =
  /\b(this|that|these|those|here|above|below|screen|page|tile|panel|card|section|view|number|figure|chart|table|column|row|badge|button)\b/i;

/**
 * Evaluate whether we should call the LLM / MCP path at all.
 * Call this at the top of handleChat before Vertex.
 */
export function evaluateDomainFirewall(
  message: string,
  opts?: { hasPageContext?: boolean },
): FirewallResult {
  const m = (message || "").trim();
  if (!m) {
    return {
      allow: false,
      reason: "empty",
      message: "Please type a question about Vanna Finance.",
    };
  }

  // 1) Hard block first
  for (const re of BLOCK_PATTERNS) {
    if (re.test(m)) {
      return { allow: false, reason: `block:${re.source.slice(0, 40)}`, message: BLOCK_MESSAGE };
    }
  }

  // 2) Explicit allow
  for (const re of ALLOW_PATTERNS) {
    if (re.test(m)) {
      return { allow: true, reason: `allow:${re.source.slice(0, 40)}` };
    }
  }

  // 2b) Asked in front of a page, about something on it.
  if (opts?.hasPageContext && DEICTIC.test(m)) {
    return { allow: true, reason: "allow:page_context" };
  }

  // 3) Very short product-ish tokens
  if (m.length <= 40 && /^(hi|hello|hey|help|thanks|thank you|ok|yes|no)\.?$/i.test(m)) {
    return {
      allow: true,
      reason: "allow:greeting",
    };
  }

  // 4) Ambiguous long text with no domain signal → refuse (saves billing)
  if (m.length > 80) {
    return { allow: false, reason: "block:no_domain_signal", message: BLOCK_MESSAGE };
  }

  // 5) Short ambiguous — still refuse unless it looks like a product noun
  if (
    /\b(what|how|why|when|where|explain|show|list|help|can\s+i|do\s+i)\b/i.test(m) &&
    !ALLOW_PATTERNS.some((re) => re.test(m))
  ) {
    // Allow only if mentions screen/page without other domain — already in ALLOW
    return { allow: false, reason: "block:off_domain_question", message: BLOCK_MESSAGE };
  }

  // Default: allow short leftovers that might be asset ticks (e.g. "BLUSDC")
  if (m.length <= 24 && /^[A-Za-z0-9\s?.!]+$/.test(m)) {
    return { allow: true, reason: "allow:short_token" };
  }

  return { allow: false, reason: "block:default", message: BLOCK_MESSAGE };
}

/** System-prompt addendum for every LLM surface. */
export const DOMAIN_FIREWALL_SYSTEM = `
DOMAIN FIREWALL (hard):
- You ONLY answer about Vanna Finance on Stellar/Soroban: Earn, Farm, Margin, wallet, swaps, health factor, pools, APY, multi-step strategies.
- REFUSE coding, homework, essays, other products, or general knowledge that is not Vanna-related.
- If off-domain, reply briefly that you only handle Vanna Finance and give one example prompt.
- Never write application code, Solidity/Python scripts, or general tech tutorials.
`;
