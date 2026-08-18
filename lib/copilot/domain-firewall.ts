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

/**
 * Questions about the assistant itself.
 *
 * "what can you do", "who are you", "help" are the first things a new user types, and
 * they were refused with "I only help with Vanna Finance…" — an answer that is both
 * unhelpful and self-contradictory, since describing what it helps with is precisely
 * what was asked. These are in-domain by definition: the subject is the product.
 */
const SELF_REFERENTIAL: RegExp[] = [
  /\b(what|which)\s+(can|could|do|does)\s+(you|u|this|it)\b/i,
  /\bwhat\s+(are\s+you|is\s+this)\b/i,
  /\b(who|what)\s+are\s+you\b/i,
  /\b(your|you)\s+(capabilities|features|abilities|commands|tools)\b/i,
  /\b(how\s+do\s+i\s+(use|start)|getting\s+started|what\s+should\s+i\s+ask)\b/i,
  // "what can I do here" asks the same thing as "what can you do" and was being refused
  // with "I only help with Vanna Finance…", which is both unhelpful and the answer to the
  // question it declined to give.
  /\bwhat\s+can\s+i\s+(do|ask|try)\b/i,
  /\b(help|examples?|options)\b\s*\??$/i,
];

/**
 * The product vocabulary, listed as words people actually type.
 *
 * WHY THIS IS A LIST AND NOT A REGEX WITH `\b` ON BOTH ENDS
 *
 * It used to be `/\b(…|position|balance|pool|price|…)\b/i`, and a trailing `\b` after a
 * singular stem does not match the plural: `position\b` fails on "positions" because `s`
 * is a word character. That one detail refused an entire class of ordinary questions —
 * "show my positions", "list all pools", "what are my balances", "what are the prices",
 * "am I close to liquidation", "what is my portfolio worth" all came back with "I only
 * help with Vanna Finance on Stellar", which is exactly the surface they were asking
 * about. The singular happened to work, so "…open position" answered and "…open
 * positions" was refused, which is how it survived: it looks like a phrasing quirk rather
 * than a systematic hole.
 *
 * Every inflection is spelled out rather than generated with `\w*`. `\w*` would also
 * accept "farmer", "trader", "owner" and "earnest", which widens the firewall past the
 * product and into the general chat it exists to keep out.
 */
const DOMAIN_WORDS = [
  // Protocol and chain
  "vanna", "stellar", "soroban", "freighter", "privy",
  "protocol", "protocols",
  "registry", "registries",
  // Venues and tickers
  "blend", "aquarius", "soroswap", "xlm", "aqua", "usdc", "blusdc", "aqusdc", "sousdc",
  "btoken", "btokens", "b-token", "vtoken", "vtokens",
  // Blend's own bToken symbols — "bXLM"/"bUSDC" name the reserve the same way "BLUSDC"
  // does, just in Blend's own notation. "What is Current Rate of bXLM?" was refused by
  // this firewall as off-topic chat because the composite symbol matched no word here.
  "bxlm", "busdc",
  // Actions
  "earn", "earns", "earning", "earnings",
  "farm", "farms", "farmed", "farming",
  "lend", "lends", "lent", "lending",
  "borrow", "borrows", "borrowed", "borrowing", "borrowings",
  "repay", "repays", "repaid", "repaying", "repayment", "repayments",
  "deposit", "deposits", "deposited", "depositing",
  "redeem", "redeems", "redeemed", "redeeming",
  "withdraw", "withdraws", "withdrew", "withdrawing", "withdrawal", "withdrawals",
  "swap", "swaps", "swapped", "swapping",
  "park", "parks", "parked", "parking",
  "stake", "stakes", "staked", "staking",
  "suppl", "supply", "supplies", "supplied", "supplying",
  "invest", "invests", "invested", "investing", "investment", "investments",
  // Positions and risk
  "position", "positions",
  "portfolio", "portfolios",
  "holding", "holdings",
  "exposure", "exposures",
  "trade", "trades", "traded", "trading",
  "collateral", "collaterals",
  "debt", "debts",
  "owe", "owes", "owed", "owing",
  "balance", "balances",
  "leverage", "leveraged", "leveraging",
  "liquidate", "liquidated", "liquidation", "liquidations", "liquidatable",
  "margin", "margins",
  "hf",
  /**
   * Credit is the product.
   *
   * Undercollateralised credit is what Vanna sells — "available credit" is a field on
   * the account state and one of the first things a trader asks for. It was missing
   * here, so "what is my available credit right now?" hit the no-product-noun rule at
   * step 5 and was refused with "I only help with Vanna Finance on Stellar" — the
   * firewall turning away the headline feature.
   */
  "credit", "credits", "creditworthiness",
  "borrowable", "headroom", "capacity",
  "solvency", "solvent", "undercollateralized", "undercollateralised",
  // Markets
  "pool", "pools",
  "reserve", "reserves",
  "liquidity",
  /**
   * "remove 50% of my LP" was refused as off-domain chat — the generic "I only help
   * with Vanna Finance" message — while "remove half my liquidity" (same request, one
   * word different) got a real, specific answer. Neither "remove" nor "LP" was in this
   * list; "liquidity" was, so only the phrasing that happened to use it passed. "LP" is
   * unambiguous in this domain (liquidity-pool position/token) and, with the `\b`
   * word-boundary matching every entry here already uses, cannot match inside another
   * word ("help" has no boundary before its "lp").
   */
  "lp", "lps",
  "apy", "apr", "tvl", "yield", "yields", "interest",
  "oracle", "oracles",
  "price", "prices", "priced", "pricing",
  // Wallet and account
  "wallet", "wallets",
  /**
   * "do I have inactive accounts" was refused as off-domain chat. Bare "account" /
   * "accounts" was never in this list — only compound phrases like "smart account" and
   * "open margin account" were — so a question naming the noun on its own had nothing to
   * match. The router already has a read for this ("inactive account" / "dormant" at
   * query_inactive_accounts); the firewall in front of it was the actual block.
   */
  "account", "accounts",
] as const;

/**
 * One alternation over DOMAIN_WORDS, longest-first.
 *
 * Longest-first matters inside an alternation: regex alternatives are tried in order, so
 * with "suppl" ahead of "supplies" the engine matches "suppl" and then fails the closing
 * `\b` against the "i" — the shorter alternative shadows the longer one and the word is
 * rejected. Sorting by length removes that ordering trap for every entry at once.
 */
const DOMAIN_WORD_RE = new RegExp(
  `\\b(?:${[...DOMAIN_WORDS].sort((a, b) => b.length - a.length).join("|")})\\b`,
  "i",
);

/** Strong in-domain signals for Vanna Finance. */
const ALLOW_PATTERNS: RegExp[] = [
  ...PAGE_REFERENTIAL,
  ...SELF_REFERENTIAL,
  DOMAIN_WORD_RE,
  /\bhealth\s*factor\b/i,
  /\bsmart\s+account\b/i,
  /\bg-?wallet\b/i,
  /\bc-?address\b/i,
  /\b(auto[- ]?sign|auto[- ]?approve|wallet\s+connect|open\s+(margin\s+)?account)\b/i,
  /\b(create|connect|setup|set\s*up|make|get|link)\b.+\b(wallet|g-?wallet|vanna\s+wallet|freighter|privy)\b/i,
  /\b(what(?:'s| is| are).+\b(on\s+(my\s+)?screen|this\s+page|shown|showing)\b)/i,
  /\b(how\s+(do|does|can|to).+\b(vanna|earn|farm|margin|lend|borrow|deposit|swap)\b)/i,
  // Multi-leg strategy language when tied to assets/actions above often co-occurs
  /\b(then|and\s+then).+\b(farm|lend|borrow|deposit|swap|repay)\b/i,
  /**
   * Protocol / contract / registry addresses.
   *
   * These are first-class product reads (`vanna_list_protocol_addresses`) and appear in
   * the Copilot prompt palette ("List protocol addresses"). Without this, "list"/"show"/
   * "what" hit the off-domain question rule while "protocol addresses" never matched the
   * vocabulary — so a built-in Vanna prompt was refused as unrelated chat.
   *
   * Compound forms only: bare "address" alone stays out (home address, etc.).
   */
  /\b(protocol|contract|registry)\s+addresses?\b/i,
  /\blist\s+(the\s+)?(protocol\s+|contract\s+|registry\s+)?addresses?\b/i,
  /**
   * "what's my net value" / "what's my net worth" / "what is my net asset value" were
   * refused as off-domain chat — the generic "I only help with Vanna Finance" message,
   * for a plain account question. Bare "net"/"worth"/"value"/"asset" are too broad for
   * `DOMAIN_WORDS` (a standalone-word list without this context would catch genuinely
   * unrelated chat too), but the compound phrases below only ever mean the account's
   * equity in this product.
   */
  /\bnet\s+(worth|value|assets?|asset\s+value)\b/i,
  /\b(portfolio|total)\s+value\b/i,
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

  // 5) A question with no product noun anywhere in it. Step 2 has already tried every
  //    allow pattern and none matched, so re-testing them here decided nothing — the
  //    second clause was always true. Dropping it changes no outcome and stops the code
  //    implying there is a further chance to be allowed.
  //    "who" was missing, so "who won the world cup" slipped past to the lenient
  //    short-token default below and spent a model call — the exact thing this file is for.
  //    In-domain "who" questions ("who are you", "who is Vanna") are already allowed at
  //    step 2 by SELF_REFERENTIAL and the product vocabulary.
  if (/\b(what|how|why|who|when|where|explain|show|list|help|can\s+i|do\s+i)\b/i.test(m)) {
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
