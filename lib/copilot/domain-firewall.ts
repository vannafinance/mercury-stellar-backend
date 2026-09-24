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

import { ASSET_DOMAIN_WORDS } from "./registry/assets";
import { classifyOrFallback, type ClassifierResult } from "./domain-classifier";
import { resolveName } from "./intent/resolve-name";
import { wouldExceedTokenCap, tokenCapMessage } from "./token-budget";

export type FirewallResult =
  | { allow: true; reason: string }
  | { allow: false; reason: string; message: string };

const BLOCK_MESSAGE =
  "I only help with Vanna Finance on Stellar — Earn, Farm, Margin, wallet connect, " +
  "swaps, health factor, and related product questions.\n\n" +
  "I can’t help with general coding, homework, or unrelated chat. " +
  "Try something like “what’s my health factor?”, “lend 10 XLM”, or " +
  "“park 20 XLM then farm 10 BLUSDC at 2x”.";

/** A paste is not an ask. Same refusal kind as an off-domain block: no reads and no loop. */
export const PASTE_REPLY = "That looks like pasted text. What would you like me to do with it?";

/**
 * When a word-list allow is not enough to skip the classifier.
 *
 * Chosen from every backtick span in the `docs/copilot/PROMPT-LIBRARY.md` headings
 * on 24 Sep 2026. Those prompts are one line. The longest is 125 characters. The
 * highest share of characters outside letters, digits, spaces and ordinary
 * punctuation is 11.1% (`MCP_TOOL_SURFACE=composites`); a real ask stays under 4%.
 * Each threshold sits above that catalogue. A pasted report clears length and
 * line count. A drawn table clears the share while it is still short.
 */
export const PASTE_SHAPE = {
  minChars: {
    value: 280,
    reason: "More than twice the longest catalogue prompt (125 characters), so a typed catalogue sentence stays a cheap allow and a multi-sentence ask does not.",
  },
  minLines: {
    value: 4,
    reason: "Every catalogue prompt is one line. Four lines is a block of text, which none of those prompts are.",
  },
  minUnusualShare: {
    value: 0.12,
    reason: "Above the catalogue's highest non-letter share (11.1%). Box-drawing and table characters are outside the ordinary set, so a drawn table clears this while it is still short.",
  },
  ordinaryPunctuation: {
    value: ".,;:!?'\"()-/",
    reason: "The marks catalogue prompts actually use: sentence punctuation, apostrophes, parentheses, hyphens and slashes. Pipes, backticks, underscores and box-drawing are outside, so they raise the share.",
  },
} as const;

const ORDINARY_PUNCTUATION = new Set(PASTE_SHAPE.ordinaryPunctuation.value);

function isOrdinaryCharacter(ch: string): boolean {
  if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return true;
  const code = ch.codePointAt(0) ?? 0;
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
  if (ORDINARY_PUNCTUATION.has(ch)) return true;
  // A non-ASCII letter (é) is still a letter. A box-drawing mark is not.
  return ch.toLowerCase() !== ch.toUpperCase();
}

/** True when the message's shape, not its words, is too large for a word-list allow. */
export function isStructurallyLarge(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (text.length >= PASTE_SHAPE.minChars.value) return true;
  if (text.split(/\r?\n/).length >= PASTE_SHAPE.minLines.value) return true;
  let unusual = 0;
  let count = 0;
  for (const ch of text) {
    count += 1;
    if (!isOrdinaryCharacter(ch)) unusual += 1;
  }
  return count > 0 && unusual / count >= PASTE_SHAPE.minUnusualShare.value;
}

/** A known in-domain message. A structurally large one still has to be classified. */
function finishAllow(message: string, reason: string): FirewallResult {
  if (isStructurallyLarge(message)) return { allow: true, reason: "allow:needs_classifier" };
  return { allow: true, reason };
}

/** Narrow abuse tripwire — cost backstop, not the primary domain gate. */
const ABUSE_TRIPWIRE: RegExp[] = [
  /\b(write|generate|debug|fix|implement|refactor|code\s+review)\b.+\b(code|function|class|script|program|api|endpoint)\b/i,
  /\b(leetcode|hackerrank|coding\s+interview|solve\s+this\s+problem|coding\s+challenge)\b/i,
  /\b(write\s+(me\s+)?a\s+(function|class|script|program|regex|dockerfile|kubernetes|app|website|bot))\b/i,
  /\b(help\s+me\s+(code|program|debug|build\s+(an?\s+)?(app|website|api)))\b/i,
  /\b(write\s+(me\s+)?(an?\s+)?(essay|homework|assignment|thesis|paper|cover\s+letter|resume)\b)/i,
  /\b(do\s+my\s+homework|solve\s+this\s+math|calculus|integral|derivative|physics\s+problem)\b/i,
  /\b(crypto\s+scam|how\s+to\s+(hack|phish|exploit)\b)/i,
  /\b(ignore\s+(all\s+)?(previous|prior)\s+(instructions|prompts|rules)|system\s+prompt|reveal\s+(your\s+)?instructions|print\s+(your\s+)?system\s+prompt|jailbreak|DAN\s+mode|developer\s+mode)\b/i,
  /\b(pretend\s+(to\s+be|you\s+are)|act\s+as\s+(a|an))\b.+\b(teacher|professor|terminal|linux|python|coder|girlfriend|boyfriend|therapist|doctor|lawyer)\b/i,
  /\b(generate\s+and\s+print|print\s+numbers|separate\s+rows\s+with|end\s+the\s+output\s+with)\b/i,
  /\b(time\s+complexity|space\s+complexity|input\s+format|output\s+format)\b/i,
];

/**
 * Questions about the surface the user is on.
 *
 * Every page in this app is a Vanna product page, so "what am I looking at?" is a
 * product question no matter how it is phrased.
 */
const PAGE_REFERENTIAL: RegExp[] = [
  /\b(this|the|current)\s+(page|screen|dashboard|view)\b/i,
  /\b(what|where)\s+am\s+i\b/i,
  /\b(looking\s+at|on\s+screen|on\s+my\s+screen|shown\s+here|right\s+here)\b/i,
  /\b(explain|walk\s+me\s+through|describe)\s+(this|the\s+page|the\s+screen)\b/i,
];

/**
 * Questions about the assistant itself.
 *
 * "what can you do", "who are you", "help" are the first things a new user types, and
 * they were refused with "I only help with Vanna Finance…" — an answer that is both
 * unhelpful and self-contradictory, since describing what it helps with is precisely
 * what was asked. These are in-domain by definition: the subject is the product.
 */
export const SELF_REFERENTIAL: RegExp[] = [
  /\b(what|which)\s+(can|could|do|does)\s+(you|u|this|it)\b/i,
  /\bwhat\s+(are\s+you|is\s+this)\b/i,
  /\b(who|what)\s+are\s+you\b/i,
  /\b(your|you)\s+(capabilities|features|abilities|commands|tools)\b/i,
  /\b(how\s+do\s+i\s+(use|start)|getting\s+started|what\s+should\s+i\s+ask)\b/i,
  // "what can I do here" asks the same thing as "what can you do" and was being refused
  // with "I only help with Vanna Finance…", which is both unhelpful and the answer to the
  // question it declined to give.
  /\bwhat\s+can\s+i\s+(do|ask|try)\b/i,
  /^(?:what\s+(?:are\s+(?:my\s+)?options|can\s+you\s+do)|show\s+options|help|examples?|options)\s*\??$/i,
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
  // Venues
  "blend", "aquarius", "soroswap",
  /**
   * Every known asset word (XLM, its bToken "bXLM", BLUSDC/AQUSDC/SOUSDC/USDT, and any
   * spelling variant), read from the ONE place that defines what an asset is
   * (`registry/assets.ts`) instead of hand-copied here. Hand-copied is exactly how "What
   * is Current Rate of bXLM?" got refused as off-topic chat: bXLM was added to the asset
   * registry's XLM aliases, and this list — a second, independent copy of "which asset
   * words exist" — was never told. Adding a spelling to the registry now reaches this
   * list automatically; see `tests/lib/asset-recognition-consistency.test.ts`.
   */
  ...ASSET_DOMAIN_WORDS,
  // Bare "USDC" deliberately has no `AssetId` of its own (see registry/assets.ts's file
  // header — BLUSDC/AQUSDC/SOUSDC are three separate tokens and naming none of them is
  // an unresolved question, not an asset) but is still a real product concept this
  // firewall must recognise, so it is listed explicitly rather than derived.
  "usdc",
  "btoken", "btokens", "b-token", "vtoken", "vtokens",
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
 * Financial & DeFi semantic vocabulary.
 *
 * Catches natural-language DeFi/financial queries that may not use exact Vanna
 * action verbs (e.g. "what is the liquidation buffer", "how much yield can I generate",
 * "explain my borrow capacity", "is my account safe").
 */
const FINANCIAL_SEMANTIC_RE =
  /\b(crypto|defi|token|tokens|coin|coins|stablecoin|stablecoins|vault|vaults|yield|yields|apy|apr|interest|rate|rates|borrow|borrowing|lend|lending|collateral|collateralized|undercollateralized|overcollateralized|liquidation|liquidate|health|hf|leverage|multiplier|solvency|headroom|cushion|buffer|threshold|safety|safe|slippage|utilization|pnl|profit|loss|returns?|roi|gain|gains|gas|fee|fees|cost|costs|transaction|transactions|tx|ledger|hash|wallet|smart\s+account|deposit|withdraw|swap|stake|staking|farming)\b/i;

/**
 * Evaluate whether we should call the LLM / MCP path at all.
 * Call this at the top of handleChat before Vertex.
 */
/** Letters and digits of one message, in order. Punctuation is a separator, not a phrase rule. */
function messageWords(message: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const ch of message) {
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) current += ch;
    else if (current) { words.push(current); current = ""; }
  }
  if (current) words.push(current);
  return words;
}

/**
 * A word the resolver calls an asset, venue, or op — exact or near — is a domain
 * name. An off-domain refusal must not fire on one. The resolver owns the distance.
 */
export function messageNamesDomain(message: string): boolean {
  for (const word of messageWords(message)) {
    const hit = resolveName(word, ["asset", "venue", "op"]);
    if (hit.kind === "exact" || hit.kind === "near") return true;
  }
  return false;
}

function refuseOffDomain(message: string, reason: string): FirewallResult {
  if (messageNamesDomain(message)) return finishAllow(message, "allow:resolved_name");
  return { allow: false, reason, message: BLOCK_MESSAGE };
}

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

  // 1) Narrow abuse tripwire first (coding-as-a-service, homework, jailbreaks)
  for (const re of ABUSE_TRIPWIRE) {
    if (re.test(m)) {
      return { allow: false, reason: `block:${re.source.slice(0, 40)}`, message: BLOCK_MESSAGE };
    }
  }

  // 2) Explicit product allow (exact domain vocabulary, assets, actions, protocol addresses).
  // A structurally large message is not finished here: a report about Vanna matches
  // the same words, and the classifier still has to decide whether it is an ask.
  for (const re of ALLOW_PATTERNS) {
    if (re.test(m)) return finishAllow(m, `allow:${re.source.slice(0, 40)}`);
  }

  // 2b) Asked in front of a page, about something on it.
  if (opts?.hasPageContext && DEICTIC.test(m)) return finishAllow(m, "allow:page_context");

  // 3) Very short product-ish tokens / greetings
  if (m.length <= 40 && /^(hi|hello|hey|help|thanks|thank you|ok|yes|no)\.?$/i.test(m)) {
    return finishAllow(m, "allow:greeting");
  }

  // 4) Semantic financial/DeFi query check
  if (FINANCIAL_SEMANTIC_RE.test(m)) return finishAllow(m, "allow:financial_semantic");

  // 5) Ambiguous long text with no domain signal → refuse (saves billing)
  if (m.length > 80) {
    return refuseOffDomain(m, "block:no_domain_signal");
  }

  // 6) A question with no product/financial noun anywhere in it.
  if (/\b(what|how|why|who|when|where|explain|show|list|help|can\s+i|do\s+i)\b/i.test(m)) {
    return refuseOffDomain(m, "block:off_domain_question");
  }

  // Default: allow a short leftover that looks like an asset ticker (e.g. "BLUSDC"),
  // not an English sentence — "give me a lasagna recipe" is 24 characters and used
  // to sneak through this gate once the recipe tripwire was narrowed.
  if (m.length <= 24 && /^[A-Za-z0-9._-]+\??$/.test(m)) {
    return finishAllow(m, "allow:short_token");
  }

  return refuseOffDomain(m, "block:default");
}

export function hasCheapDomainSignal(
  message: string,
  opts?: { hasPageContext?: boolean },
): boolean {
  const verdict = evaluateDomainFirewall(message, opts);
  return verdict.allow && verdict.reason !== "allow:needs_classifier";
}

export function abuseTripwire(message: string): Extract<FirewallResult, { allow: false }> | null {
  const m = (message || "").trim();
  if (!m) return { allow: false, reason: "empty", message: "Please type a question about Vanna Finance." };
  for (const re of ABUSE_TRIPWIRE) {
    if (re.test(m)) return { allow: false, reason: `block:${re.source.slice(0, 40)}`, message: BLOCK_MESSAGE };
  }
  return null;
}

function verdictFromClassifier(classified: ClassifierResult, large: boolean): FirewallResult {
  if (classified.kind === "token_cap") {
    return { allow: false, reason: "token_cap", message: tokenCapMessage() };
  }
  if (classified.kind === "cheap_allow" || classified.kind === "request") {
    return { allow: true, reason: classified.kind === "request" ? "request" : "cheap_allow" };
  }
  if (classified.kind === "invalid_classifier" || classified.kind === "classifier_unavailable") {
    // A short message still fail-opens into investigation. A large one does not:
    // the costly mistake is starting a read loop on a paste.
    if (large) return { allow: false, reason: classified.kind, message: PASTE_REPLY };
    return { allow: true, reason: classified.kind };
  }
  if (classified.kind === "not_a_request") {
    return { allow: false, reason: "not_a_request", message: PASTE_REPLY };
  }
  return { allow: false, reason: "off_domain", message: BLOCK_MESSAGE };
}

export async function guardUserPrompt(
  message: string,
  opts: { subject: string; signal: AbortSignal; hasPageContext?: boolean },
): Promise<FirewallResult> {
  const trip = abuseTripwire(message);
  if (trip) return trip;
  if (wouldExceedTokenCap(opts.subject)) {
    return { allow: false, reason: "token_cap", message: tokenCapMessage() };
  }
  if (hasCheapDomainSignal(message, { hasPageContext: opts.hasPageContext })) {
    return { allow: true, reason: "cheap_allow" };
  }
  const classified = await classifyOrFallback(message, opts.signal, opts.subject, false);
  return verdictFromClassifier(classified, isStructurallyLarge(message));
}

export const DOMAIN_FIREWALL_SYSTEM = `
DOMAIN FIREWALL (hard):
- You ONLY answer about Vanna Finance on Stellar/Soroban: Earn, Farm, Margin, wallet, swaps, health factor, pools, APY, multi-step strategies.
- REFUSE coding, homework, essays, other products, or general knowledge that is not Vanna-related.
- If off-domain, reply briefly that you only handle Vanna Finance and give one example prompt.
- Never write application code, Solidity/Python scripts, or general tech tutorials.
`;
