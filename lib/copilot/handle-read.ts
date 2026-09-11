/**
 * Copilot read answers — position, Earn, Farm, and the runRead dispatcher.
 *
 * Writes stay in handle.ts. This module is the remaining P2 peel of the
 * investigation-owned read cluster.
 */

import { copilotConfig } from "./config";
import { explainRead, factsForUi } from "./explain";
import { getMcpClient } from "./mcp-client";
import { RETRY, withRetry } from "./retry-policy";
import { earnPoolSymbol, displayUsdcLabel, marginCollateralSymbol } from "./mcp-write";
import { sameAsset } from "./leverage-plan";
import { parseMinHealthFactor } from "./router";
import {
  answerToText,
  completeIdentifierFacts,
  dedupeInlineIdentifiers,
  type AnswerFact,
  type AnswerVenue,
  type StructuredAnswer,
} from "./answer-schema";
import { earnPoolStructuredAnswer } from "./earn-pool-copy";
import { money, fmt2, pct, amount, usd, fmtPosAmount } from "./display-amounts";
import { usdTotal } from "./mcp-payload";
import { VANNA_AQUARIUS_FARM_PAIRS, filterAquariusFarmPools } from "./farm-pools";
import { mcpErrorResponse } from "./mcp-error-response";
import { logCopilotEvent } from "./log";
import { isTrackingSymbol } from "@/lib/account-snapshot";
import { readFarmAmmLpShares } from "./farm-lp";
import { vertexExplain, vertexExplainStructured } from "./vertex";
import { buildToolArgs } from "./tool-args";
import { resolveAsset, resolveAssetDef, USDC_VARIANTS } from "./registry/assets";
import type { ChatResponse, RoutedIntent } from "./types";

// ── Reads ─────────────────────────────────────────────────────────────────

/**
 * Reads whose answer must match the margin page exactly.
 *
 * These are the only tools where MCP and the website were observed to disagree, because
 * they are the ones that report a *position* rather than protocol-wide facts. Pool stats,
 * prices and reserve configs are the same number from either source, so they stay on MCP.
 */
const SNAPSHOT_TRUTH_TOOLS = new Set([
  "vanna_get_account_health",
  "vanna_get_collateral",
  "vanna_get_debt",
]);

/**
 * Answer a position question from the same on-chain read the margin page renders.
 *
 * WHY THIS OVERRIDES MCP RATHER THAN FALLING BACK TO IT
 *
 * MCP and the website returned different collateral for the same account — XLM 796.29 vs
 * 93.22, BLEND_USDC 42.00 vs 0, and a gross figure of $214.72 against the page's $382.87,
 * which dragged the reported health factor to 1.95 where the page showed 3.47. That is not
 * a rounding difference or a second formula; the two reads do different work.
 * `computeMarginSnapshot` runs `reconcileMarginRawSacCollateral`, checking the margin
 * account's raw Stellar Asset Contract holdings against the collateral the lending contract
 * has recorded. MCP's `get_collateral_token_balance_wad` reports the recorded balance only,
 * so anything held but not yet recorded is invisible to it.
 *
 * The website is the correct one, so it is the source of truth here — not a fallback for
 * when MCP errors, which is how this was wired before and why the disagreement survived.
 * Two different answers to "am I about to be liquidated" is the worst failure this surface
 * has, and the shared calculation is the one the user already trusts because it is what
 * their dashboard shows.
 *
 * Returns null on any failure so the MCP path still runs — a slower answer beats no answer.
 */
type MarginPositionRow = { symbol: string; amount: string; usd: number };

type MarginPositions = {
  hf: number;
  /** "∞ (no debt)" or a 2dp ratio — the same string every caller should print. */
  hfText: string;
  collateral: MarginPositionRow[];
  borrowed: MarginPositionRow[];
  grossCollateralValue: number;
  totalBorrowedValue: number;
  totalValue: number;
  collateralLeftBeforeLiquidation: number;
  netAvailableCollateral: number;
  borrowRate?: number;
};

/**
 * Did the user write Hinglish? Decides whether the answer mirrors their language.
 *
 * The old test was `/\b(kya|hai|ka|ki|ke|mujhe|kitna|kitni|batao|apy)\b/i` — and "apy"
 * was in it. So "What is the supply APY on the XLM earn pool?", written in plain English,
 * was classified as Hinglish and answered "XLM earn pool par supply APY 0.17% hai." APY is
 * the single most common noun on this surface, so this fired on a large share of ordinary
 * English questions. It also suppressed the structured-answer path, which is gated on the
 * same flag, so those turns silently lost the facts layout too.
 *
 * Now: a strong marker (a word with no English meaning) is enough on its own; the weak
 * ones — "ka", "ki", "ke", "hai" are all real English strings in other contexts — need
 * two before they count.
 */
function looksHinglish(message: string): boolean {
  const strong = /\b(kya|kaise|kitna|kitni|kitne|mujhe|batao|bataiye|karo|karna|chahiye|hain|nahi|acha|thik|zyada|kam|paisa|paise)\b/i;
  if (strong.test(message)) return true;
  const weak = message.match(/\b(hai|ka|ki|ke|se|me|mein|par|aur|toh|bhi)\b/gi) ?? [];
  return weak.length >= 2;
}

/**
 * The venue badge on an execution receipt, taken from what RAN — not from the model.
 *
 * `vertexSummarizeExecution` returns a `venue` field and the UI badges the card with it.
 * The model guessed: a plain `deposit_collateral` receipt came back badged VANNA EARN, so
 * the card named the wrong product for a margin deposit. The ops are known facts by the
 * time a receipt is written, so there is nothing to infer — a mislabelled product is the
 * one thing this surface cannot afford, since Earn, Farm and Margin hold different money.
 *
 * Mixed-venue strategies fall back to "none" rather than picking a winner: badging a
 * four-leg earn→margin→farm plan with any single venue is wrong in three ways.
 */
export function receiptVenueFromOps(ops: string[]): AnswerVenue | null {
  const seen = new Set<AnswerVenue>();
  for (const raw of ops) {
    const op = String(raw).toLowerCase();
    if (/blend/.test(op)) seen.add("blend");
    else if (/liquidity|aquarius|soroswap|swap/.test(op)) seen.add("aquarius");
    else if (/^(lend|supply|redeem)$|earn/.test(op)) seen.add("earn");
    else if (/deposit|withdraw|borrow|repay|collateral|account|settle|margin/.test(op)) {
      seen.add("margin");
    }
  }
  if (seen.size === 1) return [...seen][0];
  return seen.size > 1 ? "none" : null;
}

/**
 * Ops the browser can execute locally through the site's own audited services.
 *
 * Mirrors `EXECUTABLE_OPS` in components/copilot/execute.ts — the client refuses anything
 * outside it, so offering a fallback for an op it cannot run would strand the user on a
 * sign button that does nothing.
 */
export const LOCAL_FALLBACK_OPS = new Set([
  "withdraw_collateral",
  "deposit_collateral",
  "borrow",
  "repay",
]);

function snapshotRowLabel(symbol: string): string {
  const u = String(symbol).toUpperCase();
  if (u.startsWith("AQ_")) return "Aquarius LP";
  if (u.startsWith("SS_")) return "Soroswap LP";
  if (u === "BLEND_USDC") return "Blend USDC";
  if (u === "BLEND_XLM") return "Blend XLM";
  if (u.startsWith("BLEND_")) return `${u.slice(6)} in Blend`;
  return u;
}

function snapshotRowFacts(rows: MarginPositionRow[]): AnswerFact[] {
  return rows.map((r) => ({
    label: snapshotRowLabel(r.symbol),
    value: `${fmt2(r.amount)} (${money(r.usd)})`,
  }));
}

function collateralSummaryFacts(pos: {
  hf: number;
  hfText: string;
  grossCollateralValue: number;
  netAvailableCollateral: number;
  collateralLeftBeforeLiquidation: number;
}): AnswerFact[] {
  return [
    { label: "health factor", value: fmt2(pos.hf) },
    { label: "collateral", value: money(pos.grossCollateralValue) },
    { label: "net available collateral", value: money(pos.netAvailableCollateral) },
    { label: "collateral left before liquidation", value: money(pos.collateralLeftBeforeLiquidation) },
  ];
}

/**
 * Name a farm TRACKING position for a human, not by its internal key.
 *
 * `BLEND_USDC` is USDC supplied into Blend, and `AQ_XLM_USDC` an Aquarius LP receipt —
 * both are legitimate collateral (see `isTrackingSymbol`), but printing the raw key put
 * "372.92 BLUSDC … 10.00 BLEND_USDC" in one sentence, which reads as the same token
 * listed twice, or a typo. The row is right; only its name was internal.
 */
const positionRowLabel = (symbol: string): string => {
  const u = String(symbol).toUpperCase();
  if (u.startsWith("BLEND_")) return `${u.slice(6)} in Blend`;
  if (u.startsWith("AQ_")) return `${u.slice(3).replace(/_/g, "/")} LP on Aquarius`;
  if (u.startsWith("SS_")) return `${u.slice(3).replace(/_/g, "/")} LP on Soroswap`;
  return u;
};

/**
 * Rounded for the readable sentence — "1228.8656935 SOUSDC" (the raw on-chain amount,
 * verbatim) read as noise next to a clean dollar figure. The exact value still lives
 * in the facts card underneath (see `prettyVal` in copilot-workspace.tsx), which is
 * where a user actually checking a precise on-chain amount should look.
 */
const listPositionRows = (rows: MarginPositionRow[]): string =>
  rows.map((r) => `${fmtPosAmount(r.amount)} ${positionRowLabel(r.symbol)} (${money(r.usd)})`).join(", ");

/**
 * Which asset a position question is ABOUT, when it is about one.
 *
 * "How much XLM collateral is in C…?" and "how much USDC debt do I have?" were both
 * answered with the whole holdings table — every token, totalled — because the only
 * thing these reads looked at was the account. The named asset was parsed by the router
 * and then dropped, so a question about one token got a dump of seven, and the number
 * the user actually asked for was somewhere in the middle of it.
 *
 * Returns:
 *   an AssetId    the user named exactly one asset
 *   "USDC"        they said bare "USDC" — for a READ that is answerable (show the
 *                 variants they hold) rather than a variant chip, which is only needed
 *                 when something is about to be SPENT
 *   null          no asset named — answer with the whole account, as before
 *
 * Addresses are stripped first: a C-address is 56 base32 characters and can contain the
 * letters of a ticker by chance.
 */
function positionAssetFocus(
  routed: Extract<RoutedIntent, { kind: "read" }>,
  message: string,
): string | null {
  const fromArgs = routed.args?.symbol;
  const raw =
    typeof fromArgs === "string" && fromArgs.trim()
      ? fromArgs
      : message.replace(/\b[GC][A-Z0-9]{55,56}\b/g, " ");
  const m = resolveAsset(raw);
  if (m.kind === "asset") return m.def.id;
  if (m.kind === "ambiguous") return "USDC";
  return null;
}

/**
 * Split holdings into the ones the question was about and the rest.
 *
 * A farm TRACKING symbol is never a plain holding, whatever it resolves to. That check
 * runs first and uses the margin page's own `isTrackingSymbol`, because the two lists
 * disagreed otherwise: the asset registry aliases `BLEND_USDC` to BLUSDC (they are the
 * same token) but not `BLEND_XLM` to XLM, so Blend-supplied USDC was counted as plain
 * collateral while Blend-supplied XLM was not. Same instrument, opposite treatment,
 * from two tables that were each individually defensible.
 *
 * Tracking rows are reported separately rather than folded in or dropped — "you have
 * 893 XLM" is true, and "you also have 5.2 XLM inside Blend" is a different fact.
 */
function focusPositionRows(
  rows: MarginPositionRow[],
  focus: string,
): { matched: MarginPositionRow[]; related: MarginPositionRow[] } {
  const wanted = focus.toUpperCase();
  const ids: string[] =
    wanted === "USDC" ? [...USDC_VARIANTS] : [wanted];
  const exact = new Set<string>();
  for (const id of ids) {
    exact.add(id);
    const def = resolveAssetDef(id);
    for (const a of def?.aliases ?? []) exact.add(a.toUpperCase());
  }

  const matched: MarginPositionRow[] = [];
  const related: MarginPositionRow[] = [];
  for (const r of rows) {
    const sym = r.symbol.toUpperCase();
    const tracking = isTrackingSymbol(sym);
    if (!tracking && exact.has(sym)) {
      matched.push(r);
      continue;
    }
    // Denominated in the asset they asked about, but a different instrument.
    // Underscores become spaces so the alias scan sees BLEND_XLM as "BLEND XLM".
    const asFreeText = resolveAsset(sym.replace(/_/g, " "));
    const namesIt =
      (asFreeText.kind === "asset" && ids.includes(asFreeText.def.id)) ||
      (asFreeText.kind === "ambiguous" && wanted === "USDC") ||
      (tracking && exact.has(sym));
    if (namesIt) related.push(r);
  }
  return { matched, related };
}

/** One focused sentence: what they hold of the asset they asked about. */
function focusedPositionMessage(
  focus: string,
  noun: "collateral" | "debt",
  all: MarginPositionRow[],
  totalUsd: number,
): string {
  const { matched, related } = focusPositionRows(all, focus);
  const label = focus === "USDC" ? "USDC" : focus;
  const verb = noun === "collateral" ? "have" : "owe";
  const head = matched.length
    ? `You ${verb} ${listPositionRows(matched)}` +
      (matched.length > 1
        ? ` — ${money(matched.reduce((s, r) => s + r.usd, 0))} of ${label} ${noun === "collateral" ? "collateral" : "debt"} in total.`
        : ` of ${noun === "collateral" ? "collateral" : "debt"}.`)
    : `You have no ${label} ${noun === "collateral" ? "posted as collateral" : "debt"} on this margin account.`;

  const extra = related.length
    ? `\n\nSeparately, held through a venue rather than as plain ${label}: ${listPositionRows(related)}.`
    : "";
  const context =
    all.length > matched.length
      ? `\n\nAcross every asset your ${noun === "collateral" ? "collateral" : "debt"} totals ${money(totalUsd)}` +
        ` — ask for “my ${noun === "collateral" ? "collateral" : "debt"}” to see the full breakdown.`
      : "";
  return head + extra + context;
}

/**
 * The margin page's own read of the account, reshaped into per-token rows.
 *
 * Shared by every position answer so the health factor, the collateral list and the
 * whole-account summary can never disagree with each other about the same account.
 * Returns null on any failure; each caller decides whether that means "fall back to MCP"
 * or "answer with the venues only".
 */
export async function readMarginPositions(smartAccount: string): Promise<MarginPositions | null> {
  try {
    const [{ computeMarginSnapshot }, { HEALTH_FACTOR_INFINITY_SENTINEL }] = await Promise.all([
      import("@/lib/account-snapshot"),
      import("@/lib/margin-health"),
    ]);
    const snap = await computeMarginSnapshot(smartAccount);
    const hf = snap.avgHealthFactor;

    /** Dust is noise in a position list; below a cent is not a holding. */
    const rows = (balances: typeof snap.collateralBalances): MarginPositionRow[] =>
      Object.entries(balances)
        .map(([symbol, bal]) => ({
          symbol,
          amount: bal.amount,
          usd: Number.parseFloat(bal.usdValue) || 0,
        }))
        .filter((p) => p.usd > 0.01)
        .sort((a, b) => b.usd - a.usd);

    const borrowedRows = rows(snap.borrowedBalances);
    /**
     * `snap.collateralBalances[sym]` is a GROSS figure by design —
     * `reconcileMarginRawSacCollateral` (`farmTrackingCollateral.ts`) overlays the smart
     * account's raw on-chain token balance to fix a real staleness problem (the
     * on-chain collateral ledger doesn't update after an AMM swap/LP op), but a
     * freshly-BORROWED token also sits as raw balance until the user moves it, so this
     * gross figure silently includes debt that hasn't gone anywhere yet. Reported live
     * with side-by-side screenshots: this answer's own "collateral · XLM" was inflated
     * by exactly the account's "borrowed · XLM" figure, and same again for BLUSDC and
     * AQUSDC. The client rail (`copilot-workspace.tsx`'s `positionRows`) already nets
     * same-symbol debt out of collateral before display — this mirrors that exact rule,
     * so the copilot's own answer can never disagree with what the rail/Margin page show.
     */
    const borrowedBySymbol = new Map(borrowedRows.map((r) => [r.symbol, r]));
    const collateralRows = rows(snap.collateralBalances)
      .map((r) => {
        if (isTrackingSymbol(r.symbol)) return r;
        const debt = borrowedBySymbol.get(r.symbol);
        if (!debt) return r;
        const netAmount = Math.max(0, Number.parseFloat(r.amount) - Number.parseFloat(debt.amount));
        const netUsd = Math.max(0, r.usd - debt.usd);
        return { ...r, amount: fmtPosAmount(String(netAmount)), usd: netUsd };
      })
      .filter((p) => p.usd > 0.01);

    return {
      hf,
      hfText:
        hf >= HEALTH_FACTOR_INFINITY_SENTINEL
          ? "∞ (no debt)"
          : !(snap.totalBorrowedValue > 0) && !(snap.grossCollateralValue > 0)
            ? "n/a (no position)"
            : hf.toFixed(2),
      collateral: collateralRows,
      borrowed: borrowedRows,
      grossCollateralValue: snap.grossCollateralValue,
      totalBorrowedValue: snap.totalBorrowedValue,
      totalValue: snap.totalValue,
      collateralLeftBeforeLiquidation: snap.collateralLeftBeforeLiquidation,
      netAvailableCollateral: snap.netAvailableCollateral,
      borrowRate: snap.borrowRate,
    };
  } catch (e) {
    console.warn(
      `[copilot] margin snapshot read failed -> ` +
        `${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
    );
    return null;
  }
}

/**
 * Append the health-factor guardrails to a position answer.
 *
 * Kept separate so the warning is identical whether the answer came from the snapshot or
 * from MCP — "am I about to be liquidated" must not depend on which source replied.
 */
export function withHfGuardrails(
  message: string,
  hf: number,
  userMessage: string,
  debtUsd?: number | null,
): string {
  const userFloor = parseMinHealthFactor(userMessage);
  const floor = userFloor ?? copilotConfig.minHealthFactor;
  // 1e9-ish sentinel means no debt; a floor warning on an undebted account is noise.
  if (!Number.isFinite(hf) || hf > 1e6) return message;
  /**
   * Liquidation requires debt. HF 0 on a brand-new account (collateral $0, debt $0) is
   * "no position" — `deriveMarginHealth` returns 0 there, not the ∞ sentinel (that is
   * collateral-with-no-debt). Treating HF < 1 as liquidatable without checking debt
   * is how a fresh account got "URGENT: this account is liquidatable".
   */
  if (!(Number(debtUsd) > 0.01)) return message;
  if (hf < 1.0) {
    return (
      `${message}\n\nURGENT: health factor ${hf.toFixed(2)} is below 1.00 — this account is ` +
      `liquidatable. Repay debt or deposit collateral now.`
    );
  }
  if (hf < floor) {
    return `${message}\n\nCaution: HF ${hf.toFixed(2)} is below your safety floor (${floor}).`;
  }
  if (userFloor != null) {
    return `${message}\n\nYour floor HF ≥ ${userFloor} is currently satisfied (HF ${hf.toFixed(2)}).`;
  }
  return message;
}

/**
 * A hypothetical move stated inside a question — "simulate borrowing 10 BLUSDC",
 * "what if I deposit 500 XLM", "what happens to my HF if I repay 20 SOUSDC".
 *
 * Requires BOTH a hypothetical marker and a sized verb. "borrow 10 BLUSDC" on its own is
 * an instruction to borrow, not a question about borrowing, and must keep routing to the
 * write path — this only ever augments a READ.
 */
/**
 * The XLM price at which this position gets liquidated, as one sentence.
 *
 * Exported for tests: the arithmetic is the number that tells someone whether they are
 * about to lose their collateral, so it is worth pinning down independently of a live
 * account.
 */
export function liquidationPriceLine(pos: {
  hf: number;
  grossCollateralValue: number;
  totalBorrowedValue: number;
  collateral: Array<{ symbol: string; amount: string; usd: number }>;
}): string {
  const debt = pos.totalBorrowedValue;
  if (!(debt > 0)) {
    return "You have no debt, so there is no liquidation price — nothing can be liquidated.";
  }
  const collateral = pos.grossCollateralValue;
  if (!(collateral > 0)) return "No collateral is posted, so a liquidation price cannot be derived.";

  const xlmRow = pos.collateral.find((r) => sameAsset(r.symbol, "XLM"));
  const xlmQty = xlmRow ? Number.parseFloat(String(xlmRow.amount).replace(/,/g, "")) : 0;
  if (!Number.isFinite(xlmQty) || xlmQty <= 0) {
    return "Your collateral is all dollar stables, so there is no XLM price that liquidates this position.";
  }
  const stableUsd = pos.collateral
    .filter((r) => !sameAsset(r.symbol, "XLM"))
    .reduce((s, r) => s + r.usd, 0);

  // Derived from the live pair, so it cannot disagree with the health factor shown above.
  const lt = (pos.hf * debt) / collateral;
  if (!(lt > 0)) return "I couldn't derive your liquidation threshold from the current position.";

  const p = (debt / lt - stableUsd) / xlmQty;
  if (!(p > 0)) {
    return (
      `Your stable collateral (${money(stableUsd)}) already covers the debt on its own, so no ` +
      `XLM price liquidates this position.`
    );
  }
  const current = xlmRow ? xlmRow.usd / xlmQty : 0;
  const drop = current > 0 ? ((current - p) / current) * 100 : null;
  return (
    `Liquidation price: XLM at about $${p.toFixed(4)}` +
    (drop != null && drop > 0
      ? ` — roughly ${drop.toFixed(0)}% below the current $${current.toFixed(4)}.`
      : ".")
  );
}

export function parseHypotheticalMove(
  text: string,
): { op: "borrow" | "repay" | "deposit" | "withdraw"; asset: string; amount: number } | null {
  const t = String(text || "");
  if (!/\b(simulate|hypothetical|what\s+if|if\s+i|would\s+happen|what\s+happens)\b/i.test(t)) {
    return null;
  }
  const m = t.match(
    /\b(borrow|repay|deposit|withdraw)(?:ing|ed)?\s+(?:another\s+)?(\d+(?:\.\d+)?)\s*(XLM|BLUSDC|AQUSDC|SOUSDC|USDC)\b/i,
  );
  if (!m) return null;
  const amount = Number(m[2]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    op: m[1].toLowerCase() as "borrow" | "repay" | "deposit" | "withdraw",
    asset: m[3].toUpperCase(),
    amount,
  };
}

/** One sentence projecting the health factor after a hypothetical move. */
async function projectHealthFactor(
  hypo: { op: "borrow" | "repay" | "deposit" | "withdraw"; asset: string; amount: number },
  pos: MarginPositions,
  userId: string,
): Promise<string> {
  const collateral = pos.grossCollateralValue;
  const debt = pos.totalBorrowedValue;
  const ui = displayUsdcLabel(marginCollateralSymbol(hypo.asset), hypo.asset);

  // Price the move. Stables are $1; XLM needs the oracle and is never guessed.
  let price: number | null = /^(BLUSDC|AQUSDC|SOUSDC|USDC)$/i.test(hypo.asset) ? 1 : null;
  if (price == null) {
    try {
      const batch = await getMcpClient().call(
        "vanna_get_prices_batch",
        { symbols: [hypo.asset.toUpperCase()] },
        userId,
      );
      const prices = (batch.prices || batch) as Record<string, { price_usd?: string | number }>;
      const p = Number(
        prices[hypo.asset.toUpperCase()]?.price_usd ?? prices[hypo.asset.toLowerCase()]?.price_usd,
      );
      if (Number.isFinite(p) && p > 0) price = p;
    } catch {
      /* leave null */
    }
  }
  if (price == null) {
    return `I can't project that — the oracle price for ${ui} didn't come back, and I won't put a health factor on a guessed price.`;
  }

  const usdDelta = hypo.amount * price;
  const nextCollateral =
    hypo.op === "deposit" ? collateral + usdDelta : hypo.op === "withdraw" ? collateral - usdDelta : collateral;
  const nextDebt =
    hypo.op === "borrow" ? debt + usdDelta : hypo.op === "repay" ? Math.max(0, debt - usdDelta) : debt;

  if (nextDebt <= 0) {
    return `After repaying ${hypo.amount} ${ui} you'd have no debt left, so the health factor becomes ∞ — nothing to liquidate.`;
  }
  // Derived, not assumed: whatever threshold the snapshot used stays used.
  if (!(debt > 0) || !(collateral > 0)) {
    return `You have no debt yet, so there's no live ratio to derive your liquidation threshold from — I'd be guessing the projected figure. Ask again once the position has debt, or state the borrow and I'll size it against the risk gate.`;
  }
  const lt = (pos.hf * debt) / collateral;
  const nextHf = (nextCollateral * lt) / nextDebt;
  const verb =
    hypo.op === "borrow"
      ? `borrowing ${hypo.amount} ${ui}`
      : hypo.op === "repay"
        ? `repaying ${hypo.amount} ${ui}`
        : hypo.op === "deposit"
          ? `depositing ${hypo.amount} ${ui}`
          : `withdrawing ${hypo.amount} ${ui}`;
  return (
    `After ${verb} (${money(usdDelta)}), your health factor would be about ` +
    `${nextHf.toFixed(2)} — down from ${pos.hf.toFixed(2)}.`.replace(
      "down from",
      nextHf >= pos.hf ? "up from" : "down from",
    ) +
    (nextHf < 1.3 ? ` That is close to the ${nextHf < 1.1 ? "liquidation" : "caution"} band.` : "")
  );
}

async function snapshotPositionAnswer(
  routed: Extract<RoutedIntent, { kind: "read" }>,
  ctx: {
    userId: string;
    trader: string | null;
    smartAccount: string | null;
    request_id: string;
    message: string;
  },
): Promise<ChatResponse | null> {
  if (!ctx.smartAccount) return null;
  const pos = await readMarginPositions(ctx.smartAccount);
  if (!pos) return null;

  // Only the two per-token reads can be narrowed. A health question is about the
  // account as a whole even when it mentions an asset in passing.
  const focus =
    routed.tool === "vanna_get_collateral" || routed.tool === "vanna_get_debt"
      ? positionAssetFocus(routed, ctx.message)
      : null;

  /**
   * A real amount + symbol for the follow-up suggestion (`followUpFor` in
   * copilot-workspace.tsx), populated ONLY when the question narrowed to exactly one
   * asset. Reported live: "how much do I owe?" (no asset named, 3 different borrowed
   * assets) suggested "Repay 2 USDC" — a canned example with no relation to the real
   * $337.21 total just shown, because these slots were never populated at all and the
   * follow-up always fell back to the static placeholder. A multi-asset total still has
   * no single figure to suggest, so this stays undefined for that case on purpose —
   * FOLLOW_UP no longer offers a fabricated one either, see that map's own comment.
   */
  let focusedRow: MarginPositionRow | null = null;
  let structured: StructuredAnswer | null = null;

  let message: string;
  if (routed.tool === "vanna_get_collateral") {
    message = !pos.collateral.length
      ? "You have no collateral posted on your margin account."
      : focus
        ? focusedPositionMessage(focus, "collateral", pos.collateral, pos.grossCollateralValue)
        : `Your collateral: ${listPositionRows(pos.collateral)} — ${money(pos.grossCollateralValue)} in total.`;
    if (focus) {
      const { matched } = focusPositionRows(pos.collateral, focus);
      if (matched.length === 1) focusedRow = matched[0];
    } else if (pos.collateral.length) {
      structured = {
        headline: `Your Total Collateral is ${money(pos.grossCollateralValue)}`,
        kicker: "Your detailed stats are:",
        facts: [...collateralSummaryFacts(pos), ...snapshotRowFacts(pos.collateral)],
        venue: "margin",
      };
      message = answerToText(structured);
    }
  } else if (routed.tool === "vanna_get_debt") {
    message = !pos.borrowed.length
      ? "You have no outstanding debt on your margin account."
      : focus
        ? focusedPositionMessage(focus, "debt", pos.borrowed, pos.totalBorrowedValue)
        : `You owe ${listPositionRows(pos.borrowed)} — ${money(pos.totalBorrowedValue)} in total.`;
    if (focus) {
      const { matched } = focusPositionRows(pos.borrowed, focus);
      if (matched.length === 1) focusedRow = matched[0];
    } else if (pos.borrowed.length) {
      structured = {
        headline: `Your Total Debt is ${money(pos.totalBorrowedValue)}`,
        kicker: "Your detailed stats are:",
        facts: [
          ...(typeof pos.borrowRate === "number" && Number.isFinite(pos.borrowRate)
            ? [{ label: "net borrow rate", value: `${fmt2(pos.borrowRate)}%` }]
            : []),
          ...snapshotRowFacts(pos.borrowed),
        ],
        venue: "margin",
      };
      message = answerToText(structured);
    }
  } else {
    /**
     * "What's my health factor", "am I safe" and "am I close to liquidation" are three
     * different questions and were returning the BYTE-IDENTICAL sentence — this branch
     * never looked at `ctx.message` beyond the hypothetical/liquidation-price checks below.
     * It is deterministic on purpose (no LLM call, so it can never disagree with the margin
     * page it shares a data source with), so the fix has to stay deterministic too: a
     * keyword check picks the lead clause, not a model call.
     *
     * 1.1 here is `LIQUIDATION_THRESHOLD` from `lib/margin-health.ts` (not imported
     * statically — this file already reaches that module by dynamic import a few lines
     * down for the Soroban-budget fallback, so this follows the same pattern). 1.3 is the
     * same default safety floor `parseMinHealthFactor(...) ?? 1.3` already uses elsewhere
     * in this file — not a new number, the existing one made explicit here.
     */
    const { LIQUIDATION_THRESHOLD, HEALTH_FACTOR_INFINITY_SENTINEL: INF } = await import(
      "@/lib/margin-health"
    );
    const empty = !(pos.grossCollateralValue > 0.01) && !(pos.totalBorrowedValue > 0.01);
    const infinite = pos.hf >= INF;
    const askedDistance = /\bclose\s+to\s+liquidat|\bdistance\s+to\s+liquidat|\bhow\s+far\b.*\bliquidat/i.test(
      ctx.message,
    );
    const askedIfSafe = /\bam\s+i\s+safe\b|\bis\s+(?:it|this|my\s+(?:account|position))\s+safe\b|\bat\s+risk\b/i.test(
      ctx.message,
    );
    let lead: string;
    if (empty) {
      lead = "No margin position yet — nothing to liquidate";
    } else if (askedDistance) {
      lead = infinite
        ? "No debt, so there is nothing to liquidate"
        : `Health factor ${pos.hfText} is ${(pos.hf - LIQUIDATION_THRESHOLD).toFixed(2)} above the ${LIQUIDATION_THRESHOLD.toFixed(2)} liquidation line`;
    } else if (askedIfSafe) {
      lead = infinite
        ? "Yes — no debt, so there is nothing to liquidate"
        : pos.hf >= 1.3
          ? `Yes, you're safe — health factor ${pos.hfText} is above the 1.30 floor`
          : pos.hf > LIQUIDATION_THRESHOLD
            ? `Below your 1.30 safety floor but not liquidatable yet — health factor ${pos.hfText}`
            : `No — health factor ${pos.hfText} is at or below the ${LIQUIDATION_THRESHOLD.toFixed(2)} liquidation line`;
    } else {
      lead = `Health factor ${pos.hfText}`;
    }
    message = empty
      ? `${lead} · collateral ${money(pos.grossCollateralValue)} · borrowed ${money(pos.totalBorrowedValue)}.`
      : `${lead} · collateral ${money(pos.grossCollateralValue)} · ` +
        `borrowed ${money(pos.totalBorrowedValue)} · ` +
        `${money(pos.collateralLeftBeforeLiquidation)} of collateral left before liquidation.`;

    /**
     * "Simulate borrowing 10 BLUSDC — what happens to my health factor?" asks what the
     * number WOULD BE, and was answered with what it currently is. The question contains
     * a hypothetical and an amount; answering with today's figure looks like an answer and
     * is not one.
     *
     * The liquidation threshold is DERIVED from the live pair rather than assumed, so this
     * projection can never disagree with the snapshot it is based on. With no debt there is
     * nothing to derive it from, so the projection is declined rather than guessed — an
     * invented threshold on the number that decides liquidation is the worst thing to be
     * confidently wrong about.
     */
    const hypo = parseHypotheticalMove(ctx.message);
    if (hypo) {
      const projected = await projectHealthFactor(hypo, pos, ctx.userId);
      message += `\n\n${projected}`;
    }

    /**
     * "What's my liquidation price?" — the XLM price at which this position is liquidated.
     *
     * Only XLM moves; the USDC variants are dollar stables, so the question reduces to:
     * at what P does `(stables + xlmQty × P) × lt / debt` reach 1?
     *
     *     P* = (debt / lt − stables) / xlmQty
     *
     * A negative or zero P* means the stable collateral alone already covers the debt —
     * no XLM price can liquidate this position, and saying so is the honest answer rather
     * than printing a meaningless negative number.
     */
    if (/\bliquidat\w*\s+price\b|\bprice\b[^.]*\bliquidat/i.test(ctx.message)) {
      message += `\n\n${liquidationPriceLine(pos)}`;
    }
  }

  return {
    kind: "answer",
    message: withHfGuardrails(message, pos.hf, ctx.message, pos.totalBorrowedValue),
    ...(structured ? { answer: structured } : {}),
    /**
     * A question that narrows to ONE asset gets a facts card of ONE asset.
     *
     * Reported live: "What is my XLM Balance in Margin account?" correctly answered
     * "You have 6,975.1535 XLM ($1078.76) of collateral." in prose, but the facts card
     * underneath it dumped the health factor, debt, net value, both liquidation figures,
     * AND every other asset's amount — the exact "gross amount only, not everything else"
     * violation this session already fixed for named single-figure margin questions
     * (`marginFigureAnswer`). The prose was narrowed; the card never was.
     */
    ...(structured
      ? {}
      : {
          data: factsForUi(
            focusedRow
              ? {
                  ...(routed.tool === "vanna_get_collateral" ? { collateral_positions: [focusedRow] } : {}),
                  ...(routed.tool === "vanna_get_debt" ? { borrowed_positions: [focusedRow] } : {}),
                  asked_about: focus,
                  source: "margin_page_snapshot",
                }
              : {
                  health_factor: pos.hf,
                  collateral_usd: pos.grossCollateralValue,
                  debt_usd: pos.totalBorrowedValue,
                  net_value_usd: pos.netAvailableCollateral,
                  collateral_left_before_liquidation: pos.collateralLeftBeforeLiquidation,
                  net_available_collateral: pos.netAvailableCollateral,
                  collateral_positions: pos.collateral,
                  borrowed_positions: pos.borrowed,
                  ...(focus ? { asked_about: focus } : {}),
                  source: "margin_page_snapshot",
                },
          ),
        }),
    intent: {
      template_id: routed.template_id,
      slots: {
        source: "computeMarginSnapshot",
        ...(focus ? { asset: focus } : {}),
        ...(focusedRow ? { amount: fmtPosAmount(focusedRow.amount), symbol: focusedRow.symbol } : {}),
      },
    },
    mcp: { tool: "computeMarginSnapshot", has_unsigned_xdr: false },
    request_id: ctx.request_id,
  };
}

async function marginSideAnswer(ctx: {
  smartAccount: string | null;
  request_id: string;
  message: string;
}): Promise<ChatResponse> {
  if (!ctx.smartAccount) {
    return {
      kind: "unavailable",
      message:
        "That needs your Vanna smart account (C-address). Open a margin account, or connect the wallet that owns one.",
      intent: { template_id: "query_margin_positions" },
      request_id: ctx.request_id,
    };
  }
  const pos = await readMarginPositions(ctx.smartAccount);
  if (!pos) {
    return {
      kind: "unavailable",
      message: "I could not read your margin account just now. Your live figures are on the Margin page.",
      intent: { template_id: "query_margin_positions" },
      request_id: ctx.request_id,
    };
  }
  const structured: StructuredAnswer = {
    headline: "Here is your margin positions:",
    facts: [],
    venue: "margin",
    sections: [
      {
        body: `Your Total Collateral is ${money(pos.grossCollateralValue)}`,
        facts: [...collateralSummaryFacts(pos), ...snapshotRowFacts(pos.collateral)],
      },
      {
        body: `Your Total Debt is ${money(pos.totalBorrowedValue)}`,
        facts: [
          ...(typeof pos.borrowRate === "number" && Number.isFinite(pos.borrowRate)
            ? [{ label: "net borrow rate", value: `${fmt2(pos.borrowRate)}%` }]
            : []),
          ...snapshotRowFacts(pos.borrowed),
        ],
      },
    ],
  };
  return {
    kind: "answer",
    message: withHfGuardrails(answerToText(structured), pos.hf, ctx.message, pos.totalBorrowedValue),
    answer: structured,
    intent: { template_id: "query_margin_positions" },
    mcp: { tool: "computeMarginSnapshot", has_unsigned_xdr: false },
    request_id: ctx.request_id,
  };
}

/**
 * Structured "all open positions" card — headline + scannable facts.
 *
 * The old path jammed every holding into one comma-separated paragraph, which
 * rendered as an unreadable wall of text. Same numbers; layout via AnswerView.
 */
export function allPositionsStructured(
  pos: MarginPositions | null,
  farmProse: string,
): StructuredAnswer {
  const facts: AnswerFact[] = [];
  const hasFarmRows = Boolean(
    pos?.collateral.some((r) => isTrackingSymbol(r.symbol)) ||
      pos?.borrowed.some((r) => isTrackingSymbol(r.symbol)),
  );

  if (pos) {
    // Reused below on every `borrowed · X` row instead of a flat "warn" — a debt
    // line isn't inherently a warning, the account's actual risk tier is. A flat
    // "warn" put the same small-square glyph (AnswerFact's colorblind-accessible
    // tone shape, see TONE_MARK in answer-view.tsx) on every borrowed asset even
    // at a comfortable HF ~4.8, reading as "something is wrong here" when nothing
    // was — reported live as "what is this box representing?". A genuinely
    // stressed account (HF < 1.4) still shows it; a healthy one no longer does.
    const hfTone: AnswerFact["tone"] =
      !(pos.totalBorrowedValue > 0.01)
        ? "neutral"
        : pos.hf < 1.1
          ? "bad"
          : pos.hf < 1.4
            ? "warn"
            : "good";
    facts.push({ label: "health factor", value: pos.hfText, tone: hfTone });
    facts.push({ label: "collateral", value: money(pos.grossCollateralValue) });
    facts.push({ label: "borrowed", value: money(pos.totalBorrowedValue) });
    // "net value" must mean equity (collateral minus debt), not `pos.totalValue` —
    // that field is `netAvailableCollateral + totalBorrowedValue`, which algebraically
    // always collapses back to `grossCollateralValue` (adding debt back cancels the
    // subtraction that created it). Labeled "net", it silently showed the user their
    // GROSS collateral with no debt netted out at all.
    facts.push({ label: "net value", value: money(pos.netAvailableCollateral) });

    /**
     * `BLEND_USDC`/`AQ_XLM_USDC`/`SS_XLM_USDC` are farm-venue LP/receipt tokens, not plain
     * margin collateral the user deposited — see `isTrackingSymbol`. Reported live: they
     * were listed as `collateral · BLEND_USDC` alongside real collateral rows, reading as
     * duplicate or confusing entries. They go in the LP box (`group: "lp"`) instead, with a
     * human label via `positionRowLabel` rather than the internal key.
     */
    for (const r of pos.collateral) {
      if (isTrackingSymbol(r.symbol)) {
        facts.push({
          label: positionRowLabel(r.symbol),
          value: `${fmtPosAmount(r.amount)} (${money(r.usd)})`,
          group: "lp",
        });
      } else {
        facts.push({
          label: `collateral · ${r.symbol}`,
          value: `${fmtPosAmount(r.amount)} (${money(r.usd)})`,
        });
      }
    }
    for (const r of pos.borrowed) {
      if (isTrackingSymbol(r.symbol)) {
        facts.push({
          label: positionRowLabel(r.symbol),
          value: `${fmtPosAmount(r.amount)} (${money(r.usd)})`,
          group: "lp",
          tone: hfTone === "good" ? undefined : hfTone,
        });
      } else {
        facts.push({
          label: `borrowed · ${r.symbol}`,
          value: `${fmtPosAmount(r.amount)} (${money(r.usd)})`,
          tone: hfTone === "good" ? undefined : hfTone,
        });
      }
    }
  }

  const headline = pos
    ? `Open positions — HF ${pos.hfText}, net ${money(pos.netAvailableCollateral)}.`
    : "Open positions on your farm venues.";

  const noteParts: string[] = [];
  if (farmProse) noteParts.push(farmProse);
  if (pos && !farmProse && !hasFarmRows) {
    noteParts.push("Farm venues could not be read just now; the Farm page has the live figures.");
  }
  if (!pos && farmProse) {
    noteParts.push("Margin collateral and debt were unavailable for this turn.");
  }

  return {
    headline,
    facts,
    ...(noteParts.length ? { note: noteParts.join(" ") } : {}),
    venue: "margin",
  };
}

/** Truncate G/C addresses for scannable facts — full strkeys belong in explorers, not headlines. */
function shortAddr(addr: string | null | undefined): string | null {
  if (!addr || addr.length < 12) return addr ?? null;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function pickStellarAddr(text: string, kind: "G" | "C"): string | null {
  const m = text.match(new RegExp(`\\b${kind}[A-Z0-9]{55}\\b`));
  return m?.[0] ?? null;
}

/**
 * Open / create margin account — structured card instead of a wall of full strkeys.
 * Same MCP facts; layout via AnswerView (mirrors allPositionsStructured).
 */
export function createAccountStructured(
  rawMessage: string,
  build: Record<string, unknown>,
  opts: { trader: string | null; smartAccount: string | null; txHash: string | null },
): StructuredAnswer {
  const blob = [
    rawMessage,
    String(build.summary ?? ""),
    String(build.message ?? ""),
    String(build.smart_account ?? ""),
    String(build.account ?? ""),
    String(build.margin_account ?? ""),
  ].join(" ");

  const trader =
    opts.trader ||
    (typeof build.trader === "string" ? build.trader : null) ||
    pickStellarAddr(blob, "G");
  const smart =
    opts.smartAccount ||
    (typeof build.smart_account === "string" ? build.smart_account : null) ||
    (typeof build.account === "string" ? build.account : null) ||
    (typeof build.margin_account === "string" ? build.margin_account : null) ||
    pickStellarAddr(blob, "C");

  const alreadyOpen = /already has|NOT submitted|one-account-per-trader/i.test(blob);

  const facts: AnswerFact[] = [];
  if (trader) facts.push({ label: "trader", value: shortAddr(trader) || trader });
  if (smart) {
    facts.push({
      label: "smart account",
      value: shortAddr(smart) || smart,
      tone: "good",
    });
  }
  facts.push({
    label: "status",
    value: alreadyOpen ? "already open" : opts.txHash ? "opened on-chain" : "done",
    tone: alreadyOpen ? "warn" : "good",
  });
  if (opts.txHash) {
    facts.push({
      label: "tx",
      value: `${opts.txHash.slice(0, 10)}…`,
    });
  }

  return {
    headline: alreadyOpen
      ? "You already have a margin account."
      : "Margin account opened.",
    facts,
    note: alreadyOpen
      ? "One account per trader — nothing new was submitted. Use this C-address for deposit, borrow, and farm."
      : "Use this C-address for deposit, borrow, and farm.",
    venue: "margin",
  };
}

/**
 * "What are all my open positions?" — margin and the farm venues in one answer.
 *
 * Two sources, because no single tool holds the whole picture: `computeMarginSnapshot` has
 * collateral, debt and health factor (and is the margin page's own read, so the numbers
 * match what the user is looking at), while MCP's farm overview has the Blend supplies and
 * the Aquarius LP shares. Answering with either alone is how this question ended up being
 * half-answered: routed to the farm tool it reported LP shares and said nothing about a
 * $199 debt.
 *
 * Neither side is required. If the farm call fails the margin half still answers, and vice
 * versa; only both failing is an error, and then MCP's own message is the one worth showing.
 */
async function allPositionsAnswer(
  routed: Extract<RoutedIntent, { kind: "read" }>,
  ctx: {
    userId: string;
    trader: string | null;
    smartAccount: string | null;
    request_id: string;
    message: string;
  },
): Promise<ChatResponse> {
  const mcp = getMcpClient();
  const startedAt = Date.now();
  // computeMarginSnapshot already enriches the same account with Blend/Aquarius/
  // Soroswap tracking rows. Do not launch a second Farm overview read on the
  // normal path; it duplicated the slowest data source and made this answer wait
  // for two independent representations of the same Farm positions.
  const [pos, earnReads] = await Promise.all([
    ctx.smartAccount ? readMarginPositions(ctx.smartAccount) : Promise.resolve(null),
    // "add earn positions as well... asset supplied i have xlm, aqusdc and sousdc so it
    // should all be properly represented" — reported live: this answer covered margin
    // collateral/debt and Blend/LP, but never Earn (vToken) supply at all, even though a
    // token can be held in Earn AND margin AND a farm LP at once, three genuinely
    // different pools. Runs alongside the other two reads, not sequenced after them —
    // the "must be sequential" rule (see readEarnPositions) is about its OWN four calls
    // to each other, not about racing an unrelated tool.
    // Earn is required for this view; successful reads are cached inside
    // readEarnPositions so repeat prompts return quickly without presenting a partial
    // portfolio as complete.
    ctx.trader || ctx.smartAccount
      ? readEarnPositions(ctx, EARN_ASSETS)
      : Promise.resolve([]),
  ]);

  // Keep the MCP Farm overview as a bounded fallback only when the shared
  // snapshot failed completely. A healthy snapshot already contains Farm rows.
  const farm =
    pos || !ctx.smartAccount
      ? null
      : await Promise.race([
          mcp.call("vanna_get_farm_overview", { smart_account: ctx.smartAccount }, ctx.userId),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
        ]).catch((e: unknown) => {
          console.warn(
            `[copilot] farm overview fallback failed inside query_all_positions -> ` +
              `${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
          );
          return null;
        });

  logCopilotEvent("all_positions_sources", {
    request_id: ctx.request_id,
    elapsed_ms: Date.now() - startedAt,
    margin: Boolean(pos),
    farm: Boolean(farm) || Boolean(
      pos?.collateral.some((r) => isTrackingSymbol(r.symbol)) ||
        pos?.borrowed.some((r) => isTrackingSymbol(r.symbol)),
    ),
    earn: earnReads.filter(Boolean).length,
  });

  const earnSucceeded = earnReads.some((r) => r !== null);
  if (!pos && !farm && !earnSucceeded) {
    return {
      kind: "unavailable",
      message: ctx.smartAccount
        ? "I could not read your positions just now — neither the margin snapshot nor the farm " +
          "overview responded. Your live figures are on the Portfolio and Margin pages."
        : "That needs your Vanna smart account (C-address). Open a margin account, or connect the " +
          "wallet that owns one.",
      intent: { template_id: "query_all_positions" },
      request_id: ctx.request_id,
    };
  }

  // MCP writes its own sentence for the farm side. Reuse it rather than re-deriving
  // the counts from the payload, so the two never drift apart.
  const farmProse =
    farm && typeof farm === "object"
      ? String((farm.summary as string) || (farm.message as string) || "").trim()
      : "";

  const structured = allPositionsStructured(pos, farmProse);
  const earnSupplied = earnReads.filter(
    (r): r is NonNullable<(typeof earnReads)[number]> => r != null && r.amount > 0.0001,
  );
  for (const r of earnSupplied) {
    structured.facts.push({
      label: `earn · ${r.symbol}`,
      value: r.usd != null ? `${fmtPosAmount(String(r.amount))} (${money(r.usd)})` : fmtPosAmount(String(r.amount)),
      group: "earn",
    });
  }
  if (earnReads.length > 0 && !earnSucceeded) {
    structured.note = [
      structured.note,
      "Earn positions could not be read for this refresh; the Earn page has the live figures.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (!pos && !farm && earnSucceeded) {
    structured.headline = earnSupplied.length
      ? `Open positions — ${earnSupplied.length} Earn position${earnSupplied.length === 1 ? "" : "s"}.`
      : "Open positions — no non-zero Earn balances found.";
    structured.venue = "earn";
  }
  let message = answerToText(structured);
  if (pos) {
    message = withHfGuardrails(message, pos.hf, ctx.message, pos.totalBorrowedValue);
  }

  /**
   * Reported live: a second, raw-fact card duplicated every number the three structured
   * sections above it already show (health factor, collateral/debt USD, each asset's
   * amount, plus internal fields like "AQUARIUS LP TOKEN A"/"TRACKING SYMBOL" that mean
   * nothing to a user) — "already sare farm/margin card m dikha rahi h, combine kyu
   * dikha rahi h isko remove karo, upar k 3 kaafi h" (already shown in the farm/margin
   * cards, why show it combined again, remove it, the three above are enough). Same
   * class of bug as `copilot-redundant-card-generalized`: whenever the structured
   * answer already covers a fact, the raw dump is noise, not a second source of truth.
   * `structured.facts` (margin + LP/farm + earn, all three sections) is authoritative;
   * dropped here entirely rather than deduped.
   */
  return {
    kind: "answer",
    message,
    answer: structured,
    intent: {
      template_id: "query_all_positions",
      slots: {
        margin: Boolean(pos),
        farm: Boolean(farm) || Boolean(
          pos?.collateral.some((r) => isTrackingSymbol(r.symbol)) ||
            pos?.borrowed.some((r) => isTrackingSymbol(r.symbol)),
        ),
        earn: earnSupplied.length > 0,
      },
    },
    mcp: {
      tool: farm ? "vanna_get_farm_overview" : "computeMarginSnapshot",
      has_unsigned_xdr: false,
    },
    request_id: ctx.request_id,
  };
}

/** Every asset the Earn pool supports — the vToken-balance equivalent of ASSET_SCAN_ORDER. */
const EARN_ASSETS = ["XLM", "BLUSDC", "AQUSDC", "SOUSDC"] as const;
const EARN_POSITION_CACHE_TTL_MS = 60_000;
const earnPositionCache = new Map<string, {
  at: number;
  reads: Array<{ symbol: string; amount: number; usd: number | null } | null>;
}>();

/**
 * Read the vToken (Earn-supplied) balance for each of `assetsToQuery`. Extracted out of
 * {@link earnPositionsAnswer} so {@link allPositionsAnswer} can fold Earn into "all my
 * positions" too (reported live: the user has real supply in XLM/AQUSDC/SOUSDC Earn pools
 * and none of it showed up in that answer, which only ever covered margin + Blend/LP).
 */
async function readEarnPositions(
  ctx: { userId: string; trader: string | null; smartAccount: string | null },
  assetsToQuery: readonly (typeof EARN_ASSETS)[number][],
): Promise<Array<{ symbol: string; amount: number; usd: number | null } | null>> {
  const mcp = getMcpClient();
  const cacheKey = `${ctx.trader ?? ""}|${ctx.smartAccount ?? ""}|${assetsToQuery.join(",")}`;
  const cached = earnPositionCache.get(cacheKey);
  if (cached && Date.now() - cached.at < EARN_POSITION_CACHE_TTL_MS) return cached.reads;
  /**
   * Sequential on purpose, not Promise.all. Four concurrent `vanna_get_vtoken_balance`
   * calls against the live MCP session reliably abort with "operation was aborted due to
   * timeout" well inside the 90s per-call budget, even though any ONE of them alone
   * resolves in ~10s with the right answer — confirmed live (a single call correctly
   * returned 20.0183 XLM, matching the Earn page's own number, while the 4-way parallel
   * version returned nothing for any asset). Whatever the live MCP session is doing
   * internally, it does not like concurrent calls on this tool. Slower (~10s × up to 4
   * assets) beats fast-and-silently-wrong — the whole point of this fix was to stop
   * answering "no active Earn positions" when that is not true.
   */

  // The MCP session does not tolerate four simultaneous vToken calls; keep the read order stable
  // so a transient timeout cannot make a partial result look like an empty Earn portfolio.
  const readOne = async (symbol: (typeof EARN_ASSETS)[number]) => {
    try {
      // Earn positions are held by the G-wallet, not the margin account — vanna_lend
      // deposits from the trader's wallet and the pool mints vTokens back to that same
      // address. buildToolArgs already encodes this (`holder = trader || smart`, verified
      // against a live lend that settled on-chain while a smart-account lookup still
      // reported zero) — reuse it here instead of re-guessing the argument shape.
      const built = buildToolArgs("vanna_get_vtoken_balance", { symbol }, {
        trader: ctx.trader,
        smartAccount: ctx.smartAccount,
      });
      if (built.blocker) {
        return null;
      }
      // vanna_get_vtoken_balance does 3-4 sequential Soroban contract calls internally
      // (balance/total_supply/decimals, then convert_vtoken_to_asset, then symbol) — it
      // is genuinely slow (~10s) by design, not a simple lookup, and prone to a transient
      // "aborted due to timeout" under live testnet RPC load even well inside its own 90s
      // budget. One retry recovers most of these; a real failure still surfaces as null
      // rather than retrying forever.
      //
      // A budget overrun or other soft failure can arrive as a SUCCESSFUL response
      // carrying an `error` field rather than a thrown exception (the same shape
      // `fetchHealth` in risk.ts already guards against) — confirmed live: this
      // silently computed `amount = 0` from a genuine failure response, indistinguishable
      // from an honest zero balance, and answered "no active Earn positions" for a wallet
      // with real supply on every single asset. Must be treated as a failure, not a zero.
      let r: Record<string, unknown> | null = null;
      try {
        r = await withRetry(RETRY.mcpRead, async () => {
          const res = await mcp.call("vanna_get_vtoken_balance", built.args, ctx.userId);
          if (res?.error) {
            throw new Error(`vtoken balance returned error=${res.error}: ${String(res.message ?? "")}`);
          }
          return res;
        });
      } catch (e) {
        console.warn(
          `[copilot] vtoken balance failed for ${symbol} -> ` +
            `${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
        );
        throw e;
      }
      // `redeemable_human` (underlying token, e.g. "20.018337...") is what the Earn
      // page's own "Your Supply" column shows — NOT `human` (the vToken share count,
      // e.g. "19.9917264" VXLM for the same position). Confirmed live: reading the
      // wrong/nonexistent field names here (`balance_human`/`balance`, neither of
      // which this tool returns) silently computed 0 for every asset on every
      // account, answering "no active Earn positions" for a wallet with $70+ supplied.
      const amount = Number(r?.redeemable_human ?? r?.human ?? 0);
      // The USD variants are pegged 1:1, so their redeemable amount doubles as its own
      // USD value; XLM needs a real price. One extra call, only when XLM has a balance,
      // and resilient — a failed price lookup still shows the amount, just no USD.
      let usd: number | null = symbol === "XLM" ? null : amount;
      if (symbol === "XLM" && amount > 0.0001) {
        try {
          const priceResp = await withRetry(RETRY.mcpRead, () =>
            mcp.call("vanna_get_price", { symbol: "XLM" }, ctx.userId),
          );
          const price = Number(priceResp?.price_usd ?? priceResp?.price ?? NaN);
          if (Number.isFinite(price)) usd = amount * price;
        } catch {
          // USD estimate is best-effort — the amount itself still answers the question.
        }
      }
      return {
        symbol,
        amount: Number.isFinite(amount) ? amount : 0,
        usd,
      };
    } catch (e) {
      console.warn(
        `[copilot] vtoken balance failed for ${symbol} inside readEarnPositions -> ` +
          `${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
      );
      return null;
    }
  };

  // StellarClient/MCP vToken reads are not safe to overlap on the live session.
  // Sequential calls avoid the timeout/retry cascade seen with two workers and
  // keep the result aligned with the requested asset order.
  const out: Array<{ symbol: string; amount: number; usd: number | null } | null> = [];
  for (const symbol of assetsToQuery) {
    out.push(await readOne(symbol));
  }
  if (out.some(Boolean)) earnPositionCache.set(cacheKey, { at: Date.now(), reads: out });
  return out;
}

/**
 * "Can you provide my Earn positions" — the vToken (Earn-supplied) balance for every
 * asset Earn supports. Deliberately never falls back to `computeMarginSnapshot` or
 * `vanna_get_farm_overview` the way {@link allPositionsAnswer} does: Earn supply and
 * margin collateral are two different pools that can both hold the same token at once
 * (deposit some XLM as margin collateral, separately supply other XLM to Earn), so
 * answering "my Earn positions" with the margin account's numbers names a different
 * product's figures entirely — confirmed live, where an account with margin collateral
 * but no Earn supply got back a card plainly labeled MARGIN ACCOUNT.
 */
async function earnPositionsAnswer(
  ctx: {
    userId: string;
    trader: string | null;
    smartAccount: string | null;
    request_id: string;
    message: string;
  },
  /**
   * "What is my Overall Deposit in XLM Lending Pool" names one Earn asset — router.ts
   * passes it through as `args.symbol`. Without this, the answer always fanned out
   * across every Earn asset (reported live: a question about the XLM pool alone came
   * back listing AQUSDC and SOUSDC too), which is right for the unscoped "my Earn
   * positions" question but wrong once the user named a specific pool.
   */
  onlySymbol: (typeof EARN_ASSETS)[number] | null = null,
): Promise<ChatResponse> {
  if (!ctx.trader && !ctx.smartAccount) {
    return {
      kind: "unavailable",
      message: "Connect your wallet to read your Earn positions.",
      intent: { template_id: "query_earn_position" },
      request_id: ctx.request_id,
    };
  }

  const assetsToQuery = onlySymbol ? [onlySymbol] : EARN_ASSETS;
  const reads = await readEarnPositions(ctx, assetsToQuery);

  if (reads.every((r) => r === null)) {
    return {
      kind: "unavailable",
      message: onlySymbol
        ? `I could not read your ${onlySymbol} Earn position just now. Your live figures are on the Earn page.`
        : "I could not read your Earn positions just now. Your live figures are on the Earn page.",
      intent: { template_id: "query_earn_position" },
      request_id: ctx.request_id,
    };
  }

  const supplied = reads.filter(
    (r): r is NonNullable<(typeof reads)[number]> => r != null && r.amount > 0.0001,
  );

  const facts: AnswerFact[] = supplied.map((r) => ({
    label: `earn · ${r.symbol}`,
    value: r.usd != null ? `${fmtPosAmount(String(r.amount))} (${money(r.usd)})` : fmtPosAmount(String(r.amount)),
  }));

  const totalUsd = supplied.reduce((sum, r) => sum + (r.usd ?? 0), 0);
  const headline = supplied.length
    ? onlySymbol
      ? `Your ${onlySymbol} Earn position — ${fmtPosAmount(String(supplied[0]!.amount))} ${onlySymbol}${
          supplied[0]!.usd != null ? ` (~${money(supplied[0]!.usd!)})` : ""
        }.`
      : `Your Earn positions — ${supplied.length} supplied${totalUsd > 0 ? `, ~${money(totalUsd)} total` : ""}.`
    : onlySymbol
      ? `You have no active ${onlySymbol} Earn position right now.`
      : "You have no active Earn positions right now.";

  const structured: StructuredAnswer = { headline, facts, venue: "earn" };

  /**
   * `structured.facts` already renders "EARN · XLM: 20.0219 ($3.15)" — the raw `data`
   * card built from the same `earn_positions` array flattened out to a SECOND card
   * ("XLM AMOUNT: 20.0219") repeating the identical number, reported live. Same class
   * of bug as the generic single-read path's `suppressRawData` (see
   * copilot-redundant-card-generalized): whenever the structured answer already covers
   * the fact, the raw card is redundant, not additive — dropped rather than deduped.
   */
  return {
    kind: "answer",
    message: answerToText(structured),
    answer: structured,
    intent: { template_id: "query_earn_position", slots: { count: supplied.length } },
    mcp: { tool: "vanna_get_vtoken_balance", has_unsigned_xdr: false },
    request_id: ctx.request_id,
  };
}

/**
 * "My farm position" answered with a card explicitly badged MARGIN ACCOUNT and a note
 * admitting "Blend supplies and Aquarius LP shares stay on Farm" — the whole-account
 * fan-out's farm-overview call only ever contributes a best-effort PROSE sentence, never
 * structured facts, so a real Blend supply or Aquarius LP position never actually showed
 * up in this answer at all. Same root cause and same fix shape as the Earn-positions bug:
 * read the venue's own real state directly instead of relying on a fan-out that only
 * covers margin.
 *
 * An earlier version of this fix reused `getLitePositionsFromChain` (the Lite-mode
 * leveraged-position tracker), which nets each pool's supply against SmartAccount margin
 * debt attributed to that asset — the right number for "what's my net exposure on this
 * leveraged position", the wrong one for "how much do I have in Farm". Live-verified: a
 * real ~$49.86 Blend BLUSDC supply (confirmed on the Farm page's own Positions tab)
 * answered "$0.00" here, because unrelated margin debt in the same asset fully netted it
 * out. This reads the GROSS balance directly instead — the same on-chain calls
 * `getLitePositionsFromChain` itself makes (`BlendService`/`AquariusService`/
 * `SoroswapService`), just without the debt-netting step, so it matches what the Farm
 * page's Positions tab actually shows.
 */
async function farmPositionAnswer(
  ctx: {
    smartAccount: string | null;
    request_id: string;
  },
  venue?: "blend" | "aquarius" | "soroswap" | null,
  asset?: string | null,
): Promise<ChatResponse> {
  if (!ctx.smartAccount) {
    return {
      kind: "unavailable",
      message: "That needs your Vanna smart account (C-address). Open a margin account, or connect the wallet that owns one.",
      intent: { template_id: "query_farm_position" },
      request_id: ctx.request_id,
    };
  }

  const DUST = 1e-6;
  const facts: AnswerFact[] = [];
  const tableRows: string[][] = [];
  let totalUsd = 0;
  const farmApy = (raw: unknown, fallback = "—"): string => {
    if (raw == null || raw === "") return fallback;
    const s = String(raw).trim();
    if (/%$/.test(s)) return s;
    const n = Number(s);
    if (!Number.isFinite(n)) return fallback;
    return `${n.toFixed(2)}%`;
  };

  try {
    const [{ BlendService }, { AquariusService, AQUARIUS_POOLS, aquariusLpUnderlyingAmounts }, { SoroswapService }, { fetchTokenPrices, getCachedTokenPrice }] =
      await Promise.all([
        import("@/lib/blend-utils"),
        import("@/lib/aquarius-utils"),
        import("@/lib/soroswap-utils"),
        import("@/lib/oracle-price"),
      ]);

    await fetchTokenPrices(["XLM", "USDC"]);
    const xlmPrice = getCachedTokenPrice("XLM") || 0;
    const usdcPrice = getCachedTokenPrice("USDC") || 1;

    const [blendXlm, blendUsdc, soroswapLp, soroswapStats, blendXlmReserve, blendUsdcReserve, ...aquariusResults] = await Promise.all([
      BlendService.getUserBlendBalance(ctx.smartAccount, "XLM"),
      BlendService.getUserBlendBalance(ctx.smartAccount, "USDC"),
      SoroswapService.getLpBalance(ctx.smartAccount),
      SoroswapService.getPoolStats(),
      typeof BlendService.getBlendReserveData === "function"
        ? BlendService.getBlendReserveData("XLM").catch(() => null)
        : Promise.resolve(null),
      typeof BlendService.getBlendReserveData === "function"
        ? BlendService.getBlendReserveData("USDC").catch(() => null)
        : Promise.resolve(null),
      ...AQUARIUS_POOLS.flatMap((pool) => [
        AquariusService.getUserLpBalance(ctx.smartAccount!, pool.poolAddress, pool.tokens[0], pool.tokens[1]),
        AquariusService.getAquariusPoolStats(pool.poolAddress),
      ]),
    ]);

    if (!venue || venue === "blend") {
      const xlmUnderlying = Number.parseFloat(blendXlm.underlyingBalance) || 0;
      if (xlmUnderlying > DUST) {
        const usd = xlmUnderlying * xlmPrice;
        const bTok = fmtPosAmount(blendXlm.bTokenBalance);
        facts.push({ label: "Blend · XLM", value: `${fmtPosAmount(String(xlmUnderlying))} XLM (${money(usd)})` });
        tableRows.push([
          "Blend",
          `${fmtPosAmount(String(xlmUnderlying))} XLM (${bTok} bXLM)`,
          farmApy((blendXlmReserve as { supplyAPY?: string } | null)?.supplyAPY),
        ]);
        totalUsd += usd;
      }
      const usdcUnderlying = Number.parseFloat(blendUsdc.underlyingBalance) || 0;
      if (usdcUnderlying > DUST) {
        const usd = usdcUnderlying * usdcPrice;
        const bTok = fmtPosAmount(blendUsdc.bTokenBalance);
        facts.push({ label: "Blend · BLUSDC", value: `${fmtPosAmount(String(usdcUnderlying))} BLUSDC (${money(usd)})` });
        tableRows.push([
          "Blend",
          `${fmtPosAmount(String(usdcUnderlying))} BLUSDC (${bTok} bUSDC)`,
          farmApy((blendUsdcReserve as { supplyAPY?: string } | null)?.supplyAPY),
        ]);
        totalUsd += usd;
      }
    }

    if (!venue || venue === "soroswap") {
      const ssLp = Number.parseFloat(soroswapLp) || 0;
      const ssShares = Number.parseFloat(soroswapStats?.totalShares ?? "0");
      if (ssLp > DUST && soroswapStats && ssShares > 0) {
        const ratio = ssLp / ssShares;
        const xlm = ratio * (Number.parseFloat(soroswapStats.reserveXLM) || 0);
        const usdc = ratio * (Number.parseFloat(soroswapStats.reserveUSDC) || 0);
        const usd = xlm * xlmPrice + usdc * usdcPrice;
        if (usd > DUST) {
          facts.push({
            label: "Soroswap · XLM/USDC LP",
            // The underlying split answers "how much would I get back"; the raw LP
            // share count answers "how much do I actually hold" — reported live as
            // missing entirely, with only the underlying split shown. The USDC leg is
            // named SOUSDC, not bare "USDC" — this pool's own stable is one of three
            // USDC variants in this app, and "which one" is exactly what a Farm LP
            // answer needs to say plainly.
            value: `${fmtPosAmount(String(xlm))} XLM + ${fmtPosAmount(String(usdc))} SOUSDC (${money(usd)}) · ${fmtPosAmount(String(ssLp))} LP`,
          });
          tableRows.push([
            "Soroswap",
            `${fmtPosAmount(String(ssLp))} LP · ${fmtPosAmount(String(xlm))} XLM + ${fmtPosAmount(String(usdc))} SOUSDC`,
            farmApy((soroswapStats as { feeFraction?: string } | null)?.feeFraction, "0.30%"),
          ]);
          totalUsd += usd;
        }
      }
    }

    if (!venue || venue === "aquarius") {
      AQUARIUS_POOLS.forEach((pool, i) => {
        const lp = Number.parseFloat(String(aquariusResults[i * 2] ?? "0")) || 0;
        const stats = aquariusResults[i * 2 + 1] as Awaited<ReturnType<typeof AquariusService.getAquariusPoolStats>>;
        if (!(lp > DUST)) return;
        const displayToken = (t: string) => (t === "USDC" ? "AQUSDC" : t);
        const labelA = displayToken(pool.tokens[0]);
        const labelB = displayToken(pool.tokens[1]);
        let amountA = 0;
        let amountB = 0;
        let usd = 0;
        if (stats) {
          const under = aquariusLpUnderlyingAmounts(lp, stats, pool.tokens[0], pool.tokens[1]);
          amountA = under.amountA;
          amountB = under.amountB;
          const priceA = pool.tokens[0] === "XLM" ? xlmPrice : usdcPrice;
          const priceB = pool.tokens[1] === "XLM" ? xlmPrice : usdcPrice;
          usd = amountA * priceA + amountB * priceB;
        }
        facts.push({
          label: `Aquarius · ${labelA}/${labelB}`,
          value: stats
            ? `${fmtPosAmount(String(amountA))} ${labelA} + ${fmtPosAmount(String(amountB))} ${labelB} (${money(usd)}) · ${fmtPosAmount(String(lp))} LP`
            : `${fmtPosAmount(String(lp))} LP`,
        });
        tableRows.push([
          "Aquarius",
          stats
            ? `${fmtPosAmount(String(lp))} LP · ${fmtPosAmount(String(amountA))} ${labelA} + ${fmtPosAmount(String(amountB))} ${labelB}`
            : `${fmtPosAmount(String(lp))} LP`,
          farmApy(
            (stats as { feeFraction?: string } | null)?.feeFraction,
            "0.30%",
          ),
        ]);
        totalUsd += usd;
      });
    }
  } catch (e) {
    console.warn(
      `[copilot] farm position read failed -> ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
    );
    return {
      kind: "unavailable",
      message: "I could not read your Farm positions just now. Your live figures are on the Farm page.",
      intent: { template_id: "query_farm_position" },
      request_id: ctx.request_id,
    };
  }

  const venueLabel = venue ? venue[0].toUpperCase() + venue.slice(1) : "Farm";
  const want = (asset || "").toUpperCase();
  const rowHits = (row: string[]) => {
    if (!want) return true;
    const blob = row.join(" ").toUpperCase();
    if (want === "BLUSDC" || want === "USDC") return blob.includes("BLUSDC") || blob.includes("BUSDC");
    if (want === "AQUSDC") return blob.includes("AQUSDC") || blob.includes("AQUARIUS");
    if (want === "SOUSDC") return blob.includes("SOUSDC") || blob.includes("SOROSWAP");
    if (want === "XLM") return /\bXLM\b/.test(row[1] ?? "") || (row[0] === "Blend" && /\bXLM\b/.test(blob));
    return blob.includes(want);
  };
  const scopedRows = want ? tableRows.filter(rowHits) : tableRows;
  const missingScoped = Boolean(want && tableRows.length && !scopedRows.length);

  if (!tableRows.length) {
    const structured: StructuredAnswer = {
      headline: `Your ${venueLabel} Deposit TVL is $0.00 — no active positions.`,
      facts: [],
      venue: "none",
    };
    return {
      kind: "answer",
      message: structured.headline,
      answer: structured,
      intent: { template_id: "query_farm_position", slots: { count: 0, ...(venue ? { venue } : {}) } },
      mcp: { tool: "blend_aquarius_soroswap_on_chain", has_unsigned_xdr: false },
      request_id: ctx.request_id,
    };
  }

  const displayRows = missingScoped ? tableRows : scopedRows.length ? scopedRows : tableRows;
  const headline = missingScoped
    ? `You don't have a ${venueLabel} ${want} supply.`
    : `Your ${venueLabel} Deposit TVL is ${money(totalUsd)}.`;
  const structured: StructuredAnswer = {
    headline,
    facts,
    venue: "none",
    kicker: displayRows.length ? "Your detailed stats are:" : undefined,
    table: { columns: ["Protocol", "Holdings", "APY"], rows: displayRows },
    note: missingScoped
      ? `Your other ${venueLabel} positions are below.`
      : venue
        ? undefined
        : "Blend lending plus Aquarius/Soroswap LP — same total as Farm → Your Deposit TVL. Earn (vTokens) is separate.",
  };
  return {
    kind: "answer",
    message: answerToText(structured),
    answer: structured,
    intent: { template_id: "query_farm_position", slots: { count: facts.length } },
    mcp: { tool: "blend_aquarius_soroswap_on_chain", has_unsigned_xdr: false },
    request_id: ctx.request_id,
  };
}

async function farmStatsAnswer(
  ctx: { smartAccount: string | null; request_id: string },
  scope: "blend" | "farm",
): Promise<ChatResponse> {
  const pct = (raw: unknown): string => {
    if (raw == null || raw === "") return "—";
    const s = String(raw).trim();
    if (/%$/.test(s)) return s;
    const n = Number(s);
    return Number.isFinite(n) ? `${n.toFixed(2)}%` : "—";
  };
  let statsTable: { columns: string[]; rows: string[][] } = {
    columns: ["", "XLM", "USDC"],
    rows: [
      ["Supply APY", "—", "—"],
      ["Borrow APY", "—", "—"],
      ["Utilization", "—", "—"],
    ],
  };
  try {
    const { BlendService } = await import("@/lib/blend-utils");
    const [xlm, usdc] = await Promise.all([
      BlendService.getBlendReserveData("XLM"),
      BlendService.getBlendReserveData("USDC"),
    ]);
    statsTable = {
      columns: ["", "XLM", "USDC"],
      rows: [
        ["Supply APY", pct(xlm?.supplyAPY), pct(usdc?.supplyAPY)],
        ["Borrow APY", pct(xlm?.borrowAPY), pct(usdc?.borrowAPY)],
        ["Utilization", pct(xlm?.utilizationRate), pct(usdc?.utilizationRate)],
      ],
    };
  } catch (e) {
    console.warn(
      `[copilot] blend reserve stats failed -> ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
    );
  }
  const pos = await farmPositionAnswer(ctx, null, null);
  const posTable = pos.kind === "answer" ? pos.answer?.table : undefined;
  const tables: NonNullable<StructuredAnswer["tables"]> = [statsTable];
  tables.push({
    caption: scope === "blend" ? "Your Blend positions" : "Your Farm positions",
    columns: posTable?.columns ?? ["Protocol", "Holdings", "APY"],
    rows: posTable?.rows ?? [],
  });
  const structured: StructuredAnswer = {
    headline: scope === "blend" ? "Your Blend pool stats" : "Your Farm pool stats",
    facts: [],
    venue: "blend",
    tables,
  };
  return {
    kind: "answer",
    message: answerToText(structured),
    answer: structured,
    intent: { template_id: scope === "blend" ? "query_blend" : "query_farm_stats" },
    mcp: { tool: "blend_aquarius_soroswap_on_chain", has_unsigned_xdr: false },
    request_id: ctx.request_id,
  };
}

/**
 * "What is XLM to SoUSDC Ratio in farm Soroswap pool?" fell through to the generic
 * capabilities blurb — the only existing ratio math (the Aquarius add_liquidity clarify's
 * "Current pool ratio" note, a few hundred lines down in this file) is Aquarius-only and
 * reachable only as a side note on a blocked write, never from a plain question, and
 * nothing at all answered the same question for Soroswap.
 *
 * Reads the SAME live reserves the LP pool pages and that clarify note already use —
 * `SoroswapService.getPoolStats` / `AquariusService.getAquariusPoolStats` — so this can
 * never disagree with what the user sees there. Account-agnostic: a pool's ratio is
 * public, no smart account needed.
 */
async function poolRatioAnswer(
  venue: "soroswap" | "aquarius",
  ctx: { request_id: string },
): Promise<ChatResponse> {
  try {
    let reserveXlm: number | null = null;
    let reserveOther: number | null = null;
    let otherSymbol = "";

    if (venue === "soroswap") {
      const { SoroswapService } = await import("@/lib/soroswap-utils");
      const stats = await SoroswapService.getPoolStats();
      reserveXlm = stats ? Number.parseFloat(stats.reserveXLM) : NaN;
      reserveOther = stats ? Number.parseFloat(stats.reserveUSDC) : NaN;
      otherSymbol = "SOUSDC";
    } else {
      const [{ AquariusService, AQUARIUS_POOLS }, { CONTRACT_ADDRESSES }] = await Promise.all([
        import("@/lib/aquarius-utils"),
        import("@/lib/stellar-utils"),
      ]);
      const poolAddress =
        AQUARIUS_POOLS.find((p) => p.id === "aquarius-xlm-usdc")?.poolAddress ??
        CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL;
      const stats = poolAddress ? await AquariusService.getAquariusPoolStats(poolAddress) : null;
      reserveXlm = stats ? Number.parseFloat(stats.reserveA) : NaN;
      reserveOther = stats ? Number.parseFloat(stats.reserveB) : NaN;
      otherSymbol = "AQUSDC";
    }

    if (
      reserveXlm == null ||
      reserveOther == null ||
      !Number.isFinite(reserveXlm) ||
      !Number.isFinite(reserveOther) ||
      reserveXlm <= 0 ||
      reserveOther <= 0
    ) {
      return {
        kind: "unavailable",
        message: `I could not read the ${venue === "soroswap" ? "Soroswap" : "Aquarius"} XLM/${otherSymbol} pool just now. Its live ratio is on the Farm page.`,
        intent: { template_id: "query_pool_ratio" },
        request_id: ctx.request_id,
      };
    }

    const xlmToOther = reserveOther / reserveXlm;
    const otherToXlm = reserveXlm / reserveOther;
    const venueName = venue === "soroswap" ? "Soroswap" : "Aquarius";
    /**
     * Reported live: both directions of the ratio crammed into one sentence with a
     * middle-dot separator ("1 XLM ≈ 0.0680 SOUSDC · 1 SOUSDC ≈ 14.7109 XLM") read as a
     * run-on and was hard to scan. The headline now leads with just the figure the
     * question actually asked for (X→Y); the reverse direction lives in its own fact row
     * below, where it already had one — no reason to also cram it into the headline.
     */
    /**
     * "What are the pool stats of XLM AQUSDC pool in Aquarius" is really two questions
     * in one: what tokens make up this LP, and how much of each is in it right now.
     * The ratio alone answers neither — added the pool's two real reserve balances and
     * a composition line naming both tokens, so this doubles as the "what tokens are in
     * this LP" answer an add/remove-liquidity write also needs.
     */
    const structured: StructuredAnswer = {
      headline: `${venueName} XLM/${otherSymbol} pool ratio: 1 XLM ≈ ${xlmToOther.toFixed(4)} ${otherSymbol}.`,
      facts: [
        { label: "pool composition", value: `XLM + ${otherSymbol}` },
        { label: "1 XLM", value: `${xlmToOther.toFixed(4)} ${otherSymbol}` },
        { label: `1 ${otherSymbol}`, value: `${otherToXlm.toFixed(4)} XLM` },
        { label: "xlm in pool", value: fmtPosAmount(String(reserveXlm)) },
        { label: `${otherSymbol.toLowerCase()} in pool`, value: fmtPosAmount(String(reserveOther)) },
      ],
      venue: "none",
    };
    return {
      kind: "answer",
      message: answerToText(structured),
      answer: structured,
      intent: { template_id: "query_pool_ratio", slots: { venue } },
      mcp: { tool: venue === "soroswap" ? "soroswap_pool_stats_on_chain" : "aquarius_pool_stats_on_chain", has_unsigned_xdr: false },
      request_id: ctx.request_id,
    };
  } catch (e) {
    console.warn(
      `[copilot] pool ratio read failed -> ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
    );
    return {
      kind: "unavailable",
      message: `I could not read the ${venue === "soroswap" ? "Soroswap" : "Aquarius"} pool ratio just now.`,
      intent: { template_id: "query_pool_ratio" },
      request_id: ctx.request_id,
    };
  }
}

const MARGIN_FIGURE_LABELS: Record<string, { label: string; get: (p: MarginPositions) => number }> = {
  collateralLeftBeforeLiquidation: {
    label: "collateral left before liquidation",
    get: (p) => p.collateralLeftBeforeLiquidation,
  },
  netAvailableCollateral: { label: "net available collateral", get: (p) => p.netAvailableCollateral },
  grossCollateralValue: { label: "gross collateral", get: (p) => p.grossCollateralValue },
  totalBorrowedValue: { label: "amount borrowed", get: (p) => p.totalBorrowedValue },
};

/**
 * Answers a question that names ONE OR MORE specific margin figures — "net available
 * collateral", "collateral left before liquidation", "net amount borrowed" — with
 * exactly those numbers and nothing else.
 *
 * Reported live: these questions either fell through to the generic capabilities
 * blurb, or (worse) "collateral left before liquidation" was refused outright as a
 * restricted liquidate command. The underlying complaint generalizes beyond any one
 * phrasing: "if a user wants the gross amount of anything it should return only
 * that, not extra info" — a single-figure ask should never come back as the full
 * query_all_positions card just because that card happens to contain the number too.
 */
async function marginFigureAnswer(
  figures: string[],
  ctx: { smartAccount: string | null; request_id: string },
): Promise<ChatResponse> {
  if (!ctx.smartAccount) {
    return {
      kind: "unavailable",
      message:
        "That needs your Vanna smart account (C-address). Open a margin account, or connect the wallet that owns one.",
      intent: { template_id: "query_margin_figure" },
      request_id: ctx.request_id,
    };
  }

  const pos = await readMarginPositions(ctx.smartAccount);
  if (!pos) {
    return {
      kind: "unavailable",
      message: "I could not read your margin account just now. Your live figures are on the Margin page.",
      intent: { template_id: "query_margin_figure" },
      request_id: ctx.request_id,
    };
  }

  const defs = figures.map((key) => ({ key, def: MARGIN_FIGURE_LABELS[key] })).filter((x) => x.def != null);
  const facts: AnswerFact[] = defs.map(({ def }) => ({ label: def.label, value: money(def.get(pos)) }));
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  // Reported live: "Here's what you asked for: X, Y" read as vague filler instead of
  // naming the figures directly. Each requested figure now reads as its own clear
  // "Label: Value" clause — the same shape as the facts card underneath it.
  const headline =
    facts.length === 1
      ? `Your ${facts[0].label} is ${facts[0].value}.`
      : facts.map((f) => `${capitalize(f.label)}: ${f.value}`).join("  ·  ");

  const structured: StructuredAnswer = { headline, facts, venue: "margin" };
  return {
    kind: "answer",
    message: answerToText(structured),
    answer: structured,
    // No `data` (raw facts-grid) card — the answer above already names each requested
    // figure exactly once. A second card repeating the same number(s), unformatted and
    // with an unspaced camelCase key ("COLLATERALLEFTBEFORELIQUIDATION"), was reported
    // live as pure clutter on a single-figure answer that has nothing left to add.
    intent: { template_id: "query_margin_figure", slots: { figures } },
    mcp: { tool: "vanna_get_account_health", has_unsigned_xdr: false },
    request_id: ctx.request_id,
  };
}

/**
 * "How much interest accrued in BLUSDC" — no tool in this deployment tracks accrued
 * interest separately from principal; the debt balance itself is the compounding
 * figure, the same way a vToken's exchange rate bakes in Earn-side accrual. Answered
 * honestly with the current owed amount for the named asset plus a note explaining
 * why there is no separate interest figure, rather than fabricating one.
 */
async function accruedInterestAnswer(
  symbol: string | null,
  ctx: { smartAccount: string | null; request_id: string },
): Promise<ChatResponse> {
  if (!ctx.smartAccount) {
    return {
      kind: "unavailable",
      message:
        "That needs your Vanna smart account (C-address). Open a margin account, or connect the wallet that owns one.",
      intent: { template_id: "query_accrued_interest" },
      request_id: ctx.request_id,
    };
  }

  const pos = await readMarginPositions(ctx.smartAccount);
  if (!pos) {
    return {
      kind: "unavailable",
      message: "I could not read your margin account just now. Your live figures are on the Margin page.",
      intent: { template_id: "query_accrued_interest" },
      request_id: ctx.request_id,
    };
  }

  const want = symbol ? earnPoolSymbol(symbol) : null;
  const row = want ? pos.borrowed.find((r) => sameAsset(r.symbol, want)) : pos.borrowed[0];
  if (!row) {
    const message = want
      ? `You have no ${want} debt right now, so there is no interest accruing on it.`
      : "You have no open debt right now, so there is no interest accruing.";
    return {
      kind: "answer",
      message,
      answer: { headline: message, facts: [], venue: "margin" },
      intent: { template_id: "query_accrued_interest" },
      request_id: ctx.request_id,
    };
  }

  const structured: StructuredAnswer = {
    headline: `Your current ${row.symbol} owed is ${money(row.usd)}.`,
    facts: [{ label: `${row.symbol} owed`, value: `${fmtPosAmount(row.amount)} (${money(row.usd)})` }],
    note:
      "This deployment doesn't track accrued interest separately from principal — the amount owed above already includes it, compounding as it accrues.",
    venue: "margin",
  };
  return {
    kind: "answer",
    message: answerToText(structured),
    answer: structured,
    intent: { template_id: "query_accrued_interest", slots: { symbol: row.symbol } },
    mcp: { tool: "vanna_get_debt", has_unsigned_xdr: false },
    request_id: ctx.request_id,
  };
}

export async function runRead(
  routed: Extract<RoutedIntent, { kind: "read" }>,
  ctx: {
    userId: string;
    trader: string | null;
    smartAccount: string | null;
    request_id: string;
    message: string;
  },
): Promise<ChatResponse> {
  // "All my positions" spans margin and the farm venues, so it is answered by a fan-out
  // rather than by one tool. See allPositionsAnswer.
  if (routed.template_id === "query_all_positions") {
    return allPositionsAnswer(routed, ctx);
  }
  if (routed.template_id === "query_margin_positions") {
    return marginSideAnswer(ctx);
  }

  // "My Earn positions" names one specific product feature — see earnPositionsAnswer's
  // own doc comment for why this must never fall back to the margin/farm fan-out above.
  if (routed.template_id === "query_earn_position") {
    const scopedSymbol = routed.args?.symbol;
    const onlySymbol = (EARN_ASSETS as readonly string[]).includes(scopedSymbol as string)
      ? (scopedSymbol as (typeof EARN_ASSETS)[number])
      : null;
    return earnPositionsAnswer(ctx, onlySymbol);
  }

  // Farm Deposit TVL / "what am I farming" — same Blend + Aquarius + Soroswap snapshot
  // as the Farm page. Vertex maps these questions onto `vanna_get_farm_overview`, which
  // reads Registry tracking tokens (Aquarius LP = 0 while Farm shows 1.64 LP). Never
  // let that MCP path answer a holdings question.
  if (routed.template_id === "query_blend") {
    return farmStatsAnswer(ctx, "blend");
  }

  if (
    routed.template_id === "query_farm_position" ||
    routed.tool === "vanna_get_farm_overview" ||
    routed.tool === "vanna_get_farm_lp_position"
  ) {
    if (routed.template_id === "query_farm_stats") {
      return farmStatsAnswer(ctx, "farm");
    }
    const venue = routed.args?.venue;
    const scopedAsset = typeof routed.args?.asset === "string" ? routed.args.asset : null;
    return farmPositionAnswer(
      ctx,
      venue === "blend" || venue === "aquarius" || venue === "soroswap" ? venue : null,
      scopedAsset,
    );
  }

  // "What is XLM to SoUSDC Ratio in farm Soroswap pool?" — see poolRatioAnswer's own
  // doc comment for why this reads live pool reserves directly instead of failing to
  // a generic capabilities blurb.
  if (routed.template_id === "query_pool_ratio") {
    const venue = routed.args?.venue === "soroswap" ? "soroswap" : "aquarius";
    return poolRatioAnswer(venue, ctx);
  }

  // "What is my net available collateral & net amount borrowed" names specific figures —
  // see marginFigureAnswer's own doc comment for why this must answer with ONLY those,
  // not the full query_all_positions card.
  if (routed.template_id === "query_margin_figure") {
    const figures = Array.isArray(routed.args?.figures) ? (routed.args.figures as string[]) : [];
    return marginFigureAnswer(figures, ctx);
  }

  // "How much interest accrued in BLUSDC" — see accruedInterestAnswer's own doc comment
  // for why this answers honestly from the current debt figure instead of a fabricated one.
  if (routed.template_id === "query_accrued_interest") {
    const symbol = typeof routed.args?.symbol === "string" ? routed.args.symbol : null;
    return accruedInterestAnswer(symbol, ctx);
  }

  // Farmable Aquarius pools are Vanna's own pairs, not the full AMM API dump.
  // Counts come from VANNA_AQUARIUS_FARM_PAIRS so the prose can't drift from the
  // list the way a hardcoded "exactly 3" did once XLM/AQUA was removed.
  if (routed.tool === "vanna_list_aquarius_pools") {
    const mcp = getMcpClient();
    try {
      const raw = await mcp.call("vanna_list_aquarius_pools", {}, ctx.userId);
      const filtered = filterAquariusFarmPools(raw);
      const known = VANNA_AQUARIUS_FARM_PAIRS.length;
      const found = filtered.pools.length;
      const proseWidth = Math.max(1, ...filtered.pools.map((p) => String(p.pair).length));
      const prose =
        `Vanna has ${known} farmable Aquarius pool${known === 1 ? "" : "s"}:\n` +
        filtered.pools
          .map(
            (p) =>
              `• ${String(p.pair).padEnd(proseWidth)}  APY ${pct(p.total_apy_pct)}` +
              (p.liquidity_usd != null ? `  ·  liquidity ${usd(p.liquidity_usd)}` : "") +
              (p.pool_address ? `  ·  ${String(p.pool_address).slice(0, 8)}…` : ""),
          )
          .join("\n") +
        (found < known
          ? `\n\n(Only ${found} of the ${known} returned live API stats; the rest may be offline on testnet.)`
          : "");
      return {
        kind: "answer",
        message: prose,
        data: factsForUi({
          count: filtered.pools.length,
          pools: filtered.pools,
          note: "Vanna farm surface: XLM/USDC and XLM/USDT only (no XLM/AQUA pool exists).",
        }),
        intent: { template_id: "query_aquarius_pools", slots: { count: filtered.pools.length } },
        mcp: { tool: "vanna_list_aquarius_pools", has_unsigned_xdr: false },
        request_id: ctx.request_id,
      };
    } catch (e) {
      return mcpErrorResponse(e, ctx.request_id, routed.template_id);
    }
  }

  // Fan-out: all Vanna earn pools (Sanujit E3/E4) — MCP has no list-all tool.
  if (
    routed.tool === "vanna_get_pool_stats" &&
    (routed.args?.symbol === "__ALL_EARN__" || routed.template_id === "query_all_earn_pools")
  ) {
    const mcp = getMcpClient();
    const pools = [
      { query: "XLM", display: "XLM" },
      { query: "USDC", display: "BLUSDC" },
      { query: "AQUSDC", display: "AQUSDC" },
      { query: "SOUSDC", display: "SOUSDC" },
    ] as const;
    /**
     * An upstream failure can arrive as an HTML error PAGE, not a sentence.
     *
     * A WorkOS token-endpoint 520 put `<!DOCTYPE html><!--[if lt IE 7]>…` straight into
     * the answer text, where a pool's APY should have been. Tags are stripped, the known
     * infra faults get a plain sentence, and anything else is capped — an error message is
     * still an answer, and it has to read like one.
     */
    const shortError = (e: unknown): string => {
      const s = String(e ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (/token endpoint returned 5\d\d|workos/i.test(s)) {
        return "upstream auth error — try again in a moment";
      }
      if (/\b5\d\d\b|timeout|ECONNRESET|fetch failed/i.test(s)) {
        return "upstream error — try again in a moment";
      }
      if (!s) return "unavailable";
      return s.length > 120 ? `${s.slice(0, 117)}…` : s;
    };

    const rows: Array<Record<string, unknown>> = [];
    for (const p of pools) {
      try {
        const data = await mcp.call("vanna_get_pool_stats", { symbol: p.query }, ctx.userId);
        rows.push({
          symbol: p.display,
          supply_apy_pct: data.supply_apy_pct ?? data.supply_apr_pct,
          borrow_apr_pct: data.borrow_apr_pct,
          utilization_pct: data.utilization_pct,
          total_liquidity_human: data.total_liquidity_human ?? data.total_liquidity,
          total_assets_human: data.total_assets_human ?? data.total_assets,
          error: data.error,
        });
      } catch (e) {
        rows.push({ symbol: p.display, error: shortError(e instanceof Error ? e.message : e) });
      }
    }
    /**
     * "Compare the XLM and BLUSDC pools" names TWO pools and asks which is better.
     *
     * It was answered with all four pools and the highest-yield winner — which is neither
     * a comparison nor restricted to what was asked. Naming pools narrows the set; asking
     * to compare means the answer must lead with a verdict and the size of the gap, not
     * leave the user to subtract two percentages themselves.
     *
     * Bare "USDC" expands to all three variants rather than picking one, because they are
     * different tokens with different rates and guessing which was meant is the mistake
     * the variant work exists to prevent.
     */
    const named = new Set<string>();
    if (/\bxlm\b/i.test(ctx.message)) named.add("XLM");
    if (/\bblusdc\b|\bblend[\s_-]?usdc\b/i.test(ctx.message)) named.add("BLUSDC");
    if (/\baqusdc\b|\baquarius[\s_-]?usdc\b/i.test(ctx.message)) named.add("AQUSDC");
    if (/\bsousdc\b|\bsoroswap[\s_-]?usdc\b/i.test(ctx.message)) named.add("SOUSDC");
    const bareUsdc =
      /\busdc\b/i.test(ctx.message) &&
      !/\b(blusdc|aqusdc|sousdc)\b/i.test(ctx.message);
    if (bareUsdc) {
      named.add("BLUSDC");
      named.add("AQUSDC");
      named.add("SOUSDC");
    }

    /**
     * "USDC pool stats" asked about USDC, not XLM — showing XLM alongside it answered a
     * bigger question than the one asked. Only a bare, unqualified "USDC" narrows the set
     * this way; a genuine "list all earn pools"/"highest APY" request names no "usdc" at
     * all and is unaffected, so it still shows every pool including XLM.
     */
    const displayRows = bareUsdc ? rows.filter((r) => r.symbol !== "XLM") : rows;
    const asPoolRows = (list: Array<Record<string, unknown>>) =>
      list.map((r) => ({
        symbol: String(r.symbol),
        supply_apy_pct: r.supply_apy_pct,
        borrow_apr_pct: r.borrow_apr_pct,
        utilization_pct: r.utilization_pct,
        total_assets_human: r.total_assets_human,
        total_liquidity_human: r.total_liquidity_human,
        error: r.error,
      }));
    const asksCompare = /\bcompare\b|\bvs\.?\b|\bversus\b|\bbetter\b|\bdifference between\b/i.test(
      ctx.message,
    );
    if (asksCompare && named.size >= 2) {
      const sel = rows.filter((r) => named.has(String(r.symbol)));
      const ok = sel
        .filter((r) => !r.error && r.supply_apy_pct != null)
        .sort((a, b) => Number(b.supply_apy_pct) - Number(a.supply_apy_pct));
      const top = ok[0];
      const next = ok[1];
      const head =
        top && next
          ? `${top.symbol} pays more for supplying: ${pct(top.supply_apy_pct)} vs ` +
            `${pct(next.supply_apy_pct)} on ${next.symbol} — ` +
            `${(Number(top.supply_apy_pct) - Number(next.supply_apy_pct)).toFixed(2)} points apart.` +
            (Number(top.utilization_pct) > 80
              ? ` Note ${top.symbol} is ${pct(top.utilization_pct)} utilised, so withdrawal liquidity is thin.`
              : "")
          : `Only one of those pools returned live stats, so there is nothing to compare it against.`;
      const structured = earnPoolStructuredAnswer({
        rows: asPoolRows(sel),
        usdcOnly: bareUsdc,
        compareHead:
          head +
          (bareUsdc ? ` “USDC” is three different tokens here, so all three are shown.` : ""),
      });
      return {
        kind: "answer",
        message: answerToText(structured),
        answer: structured,
        data: factsForUi({ compared: [...named] }),
        intent: { template_id: "query_all_earn_pools", slots: { compared: [...named] } },
        mcp: { tool: "vanna_get_pool_stats", has_unsigned_xdr: false },
        request_id: ctx.request_id,
      };
    }
    /**
     * "Total value locked across all earn pools" asks for ONE number.
     *
     * The fan-out below lists four pools and names the best-paying one — a good answer to
     * a question nobody asked. Worse, the per-pool figures are in TOKENS, so a reader
     * adding them up by eye would sum XLM to USDC and get a number that means nothing.
     *
     * TVL is total ASSETS supplied (not the liquidity still available to borrow), valued
     * in USD. Stables are $1; XLM needs the oracle, and if that read fails the total is
     * omitted rather than guessed — a TVL quoted at an invented XLM price would be wrong
     * by an order of magnitude and look authoritative.
     */
    const wantTotal =
      /\btvl\b|\btotal value\b|\btotal\b[^.]*\block/i.test(ctx.message) ||
      /\b(combined|altogether|in total|across all)\b/i.test(ctx.message);

    let tvlUsd: number | null = null;
    let tvlPartial = false;
    if (wantTotal) {
      let xlmPrice: number | null = null;
      try {
        const batch = await getMcpClient().call(
          "vanna_get_prices_batch",
          { symbols: ["XLM"] },
          ctx.userId,
        );
        const prices = (batch.prices || batch) as Record<string, { price_usd?: string | number }>;
        const p = Number(prices.XLM?.price_usd ?? prices.xlm?.price_usd);
        if (Number.isFinite(p) && p > 0) xlmPrice = p;
      } catch {
        /* leave null — the total is then omitted, never guessed */
      }
      let sum = 0;
      for (const r of displayRows) {
        const raw = r.total_assets_human ?? r.total_liquidity_human;
        const units = Number.parseFloat(String(raw ?? "").replace(/,/g, ""));
        if (!Number.isFinite(units)) {
          tvlPartial = true;
          continue;
        }
        const price = String(r.symbol) === "XLM" ? xlmPrice : 1;
        if (price == null) {
          tvlPartial = true;
          continue;
        }
        sum += units * price;
      }
      if (!tvlPartial || sum > 0) tvlUsd = sum;
      if (tvlPartial && sum === 0) tvlUsd = null;
    }

    const wantHighest = /highest|best|top/i.test(ctx.message);
    if (wantTotal) {
      const head =
        tvlUsd != null
          ? `Total value locked across all ${displayRows.length} Vanna earn pools is ${usd(tvlUsd)}` +
            (tvlPartial ? " (some pools could not be valued — see below)." : ".")
          : `I couldn't total the pools — the XLM oracle price didn't come back, and I won't ` +
            `quote a TVL built on a guessed price.`;
      const structured = earnPoolStructuredAnswer({
        rows: asPoolRows(displayRows),
        usdcOnly: bareUsdc,
        compareHead: head,
      });
      return {
        kind: "answer",
        message: answerToText(structured),
        answer: structured,
        data: factsForUi({ tvl_usd: tvlUsd }),
        intent: { template_id: "query_all_earn_pools", slots: { pools: [...pools] } },
        mcp: { tool: "vanna_get_pool_stats", has_unsigned_xdr: false },
        request_id: ctx.request_id,
      };
    }
    const structured = earnPoolStructuredAnswer({
      rows: asPoolRows(displayRows),
      usdcOnly: bareUsdc,
      wantHighest,
    });
    return {
      kind: "answer",
      message: answerToText(structured),
      answer: structured,
      intent: { template_id: "query_all_earn_pools", slots: { pools: [...pools] } },
      mcp: { tool: "vanna_get_pool_stats", has_unsigned_xdr: false },
      request_id: ctx.request_id,
    };
  }

  const built = buildToolArgs(routed.tool, routed.args, {
    trader: ctx.trader,
    smartAccount: ctx.smartAccount,
  });
  if (built.blocker) {
    return {
      kind: "unavailable",
      message: built.blocker,
      intent: { template_id: routed.template_id, slots: routed.args },
      request_id: ctx.request_id,
    };
  }

  // Position questions answer from the same read the margin page renders, before MCP is
  // consulted at all. See snapshotPositionAnswer for why the two sources disagree.
  if (SNAPSHOT_TRUTH_TOOLS.has(routed.tool) && ctx.smartAccount) {
    const fromSnapshot = await snapshotPositionAnswer(routed, ctx);
    if (fromSnapshot) return fromSnapshot;
  }

  try {
    const mcp = getMcpClient();
    const data = await mcp.call(routed.tool, built.args, ctx.userId);

    // A Soroban budget overrun comes back as a SUCCESSFUL response carrying an error
    // field — it never rejects. So the ExceededLimit fallback in the catch below was
    // unreachable, and "my health factor" answered "no value available" while
    // vanna_get_collateral ($214.70) and vanna_get_debt ($110.25) were both returning
    // fine. Re-raise so that fallback runs. Scoped to budget/resource faults: other
    // error payloads keep their existing handling.
    {
      const payload = data as Record<string, unknown> | null;
      const detail = String(payload?.message ?? payload?.error ?? "");
      if (payload?.error && /Budget|ExceededLimit|resource limit/i.test(detail)) {
        throw new Error(detail);
      }
    }

    let prose: string;
    const hinglish = looksHinglish(ctx.message);

    // Structured first: the UI renders headline/facts/venue itself, so number formatting
    // and venue labelling stop depending on the model following prompt rules. Falls back
    // to the prose path on any failure, and is skipped for Hinglish, where the value is
    // in the model's own phrasing rather than in a fixed layout.
    /**
     * Name the pool that was actually read, not the wire symbol three pools share.
     *
     * BLUSDC, AQUSDC and SOUSDC are separate pools that all report `pool symbol: "USDC"` on
     * the wire. So "BLUSDC pool stats" came back labelled "The USDC Vanna earn pool … 1,536
     * USDC total liquidity" — right numbers, wrong name, and indistinguishable from the other
     * two pools' answers. That is the failure the test script flags at R-11 and the reason
     * R-11/R-12/R-13 all read as wrong.
     *
     * This does NOT relabel from the user's word — that is the documented P0 (a swap card
     * once said BLUSDC while buying AQUSDC). `built.args.symbol` is the same resolved value
     * that ends up in `intent.slots` a few lines down and the same one that picked which
     * pool to call, so it agrees with the data by construction. (Not `routed.args.symbol` —
     * that is the router's PRE-normalisation guess; `buildToolArgs` is what upper-cases it
     * and applies the "USDC" fallback, so reading `routed.args` here silently never matched
     * and the fix did nothing.) The substitution is deliberately narrow: only when the wire
     * value is exactly the ambiguous shared symbol, and only for a variant known to share it.
     */
    const resolvedSymbol = (built.args as Record<string, unknown> | undefined)?.symbol;
    if (typeof resolvedSymbol === "string" && /^(BLUSDC|AQUSDC|SOUSDC)$/i.test(resolvedSymbol)) {
      // Both spellings: the MCP sends `pool_symbol`, and `factsForUi` is what turns
      // underscores into spaces for display. Reading only the spaced form meant this
      // matched nothing on the raw payload — the second reason this fix sat dead.
      for (const key of ["pool_symbol", "pool symbol", "symbol"]) {
        if (data[key] === "USDC") data[key] = resolvedSymbol.toUpperCase();
      }
    }

    let structured: StructuredAnswer | null = null;
    if (!hinglish) {
      if (routed.tool === "vanna_get_pool_stats" && routed.template_id === "query_pool_stats") {
        const display =
          typeof resolvedSymbol === "string" && resolvedSymbol.toUpperCase() === "USDC"
            ? "BLUSDC"
            : String(resolvedSymbol || data.symbol || "XLM").toUpperCase();
        structured = earnPoolStructuredAnswer({
          rows: [
            {
              symbol: display,
              supply_apy_pct: data.supply_apy_pct ?? data.supply_apr_pct,
              borrow_apr_pct: data.borrow_apr_pct,
              utilization_pct: data.utilization_pct,
              total_assets_human: data.total_assets_human ?? data.total_assets,
              total_liquidity_human: data.total_liquidity_human ?? data.total_liquidity,
              error: data.error,
            },
          ],
        });
      } else {
        structured = await vertexExplainStructured(ctx.message, routed.tool, data);
      }
      /**
       * An enumeration must arrive whole — but only when the question WAS one.
       * `completeIdentifierFacts` exists for "show me the protocol contract addresses":
       * the model is capped at six facts, so a genuinely broad ask put six of fifteen in
       * the card and left the rest to the generic facts dump underneath it. Reported
       * live: "Give me XLM Lending Pool Address" — a question naming exactly ONE
       * contract — got the SAME unconditional treatment and padded back out to all 9
       * addresses, defeating the model's own correct one-item answer. A plural
       * "addresses" (or "all"/"every"/"list") is the actual signal that every identifier
       * was wanted; a singular, specifically-named ask (one contract, or "the oracle and
       * account manager") means the model's own narrower answer is the right one to
       * trust as-is.
       */
      const isBroadIdentifierAsk = /\b(all|every|list)\b|\baddresses\b/i.test(ctx.message);
      if (structured && isBroadIdentifierAsk) structured = completeIdentifierFacts(structured, data);
      // The value only needs to live once — in its own copyable row below, not also
      // spelled out in the prose above it. See dedupeInlineIdentifiers's own comment.
      if (structured) structured = dedupeInlineIdentifiers(structured);
      /**
       * "Can I borrow 20 BLUSDC?" answered "You cannot borrow 20 BLUSDC from the Vanna
       * earn pool because your collateral health is insufficient" — a genuine MARGIN
       * pre-flight (`vanna_can_borrow`/`vanna_can_withdraw` both map to `vanna_margin_trade`,
       * mcp-client.ts; `collateral_health` as a limiting factor is a margin risk-engine
       * concept, meaningless for an Earn deposit), mislabeled by the model as being about
       * "the Vanna earn pool" — this generic path has no dedicated handler the way
       * `query_margin_figure`/`query_accrued_interest` do, so `venue` and the venue's NAME
       * inside the prose sentence are both a free guess from the tool name alone, and
       * `vanna_can_borrow`'s BLUSDC/AQUSDC/SOUSDC symbols read as Earn-pool-flavoured to
       * the model with no venue hint otherwise. These two tools only ever check the margin
       * account, never Earn, so the venue is corrected deterministically here rather than
       * left to a per-call guess.
       */
      if (structured && (routed.tool === "vanna_can_borrow" || routed.tool === "vanna_can_withdraw")) {
        structured = {
          ...structured,
          venue: "margin",
          headline: structured.headline.replace(
            /\bthe\s+vanna\s+earn\s+pool\b|\bvanna'?s?\s+earn\s+pool\b|\bthe\s+earn\s+pool\b/gi,
            "your margin account",
          ),
        };
      }
    }
    // Deliberately not an early return: the HF guardrails and response assembly below
    // must still run, so this only supplies the text and rides along as `answer`.
    if (structured) {
      prose = answerToText(structured);
    } else {
      try {
        prose = await vertexExplain(
          hinglish
            ? `${ctx.message}\n\n(Reply in the same language mix as the user — clear Hinglish is fine.)`
            : ctx.message,
          routed.tool,
          data,
        );
      } catch {
        prose = explainRead(routed.tool, data, ctx.message);
      }
    }
    prose = prose.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");

    // Liquidation / HF guardrails on health reads (standing safety agent).
    if (routed.tool === "vanna_get_account_health") {
      const hf = Number(
        (data as Record<string, unknown>).health_factor ??
          (data as Record<string, unknown>).hf ??
          (data as Record<string, unknown>).avg_health_factor,
      );
      const debt = Number(
        (data as Record<string, unknown>).debt_usd ??
          (data as Record<string, unknown>).total_debt_usd ??
          (data as Record<string, unknown>).debt,
      );
      const userFloor = parseMinHealthFactor(ctx.message);
      const floor = userFloor ?? 1.3;
      if (Number.isFinite(hf) && Number(debt) > 0.01) {
        if (hf < 1.0) {
          prose +=
            `\n\nURGENT: health factor ${hf.toFixed(2)} is below 1.00 — this account is liquidatable. ` +
            `Repay debt or deposit collateral now (e.g. “repay 5 AQUSDC” or “deposit 20 XLM as collateral”). ` +
            `I will not auto-move funds without your go-ahead on this turn; say “repay what I need to get safe” to act.`;
        } else if (hf < floor) {
          prose +=
            `\n\nCaution: HF ${hf.toFixed(2)} is below your safety floor (${floor}). ` +
            `Avoid new borrows; consider repay or more collateral to stay clear of liquidation.`;
        } else if (userFloor != null) {
          prose += `\n\nYour floor HF ≥ ${userFloor} is currently satisfied (HF ${hf.toFixed(2)}).`;
        }
      }
    }

    /**
     * "Can I borrow 20 BLUSDC?" and, separately, "AQUSDC pool stats" each rendered a
     * SECOND card underneath the answer's own facts, duplicating it: a smart account
     * address / pool symbol nobody asked for, `..._pct`/`..._human` twins of the SAME
     * figures at raw 18-decimal precision instead of the already-shown rounded ones,
     * and a `reason`/`note supply apr` paragraph repeating the note already on screen.
     * The client's own dedup (`shown`, copilot-workspace.tsx) only matches by exact
     * string value, so a rounded structured fact ("10.38%") never matches its own
     * full-precision raw twin ("10.375107") and both rendered.
     *
     * General fix, not a per-tool one: whenever the structured path succeeds, its
     * headline/facts/note ARE the curated answer — nothing in the separate raw `data`
     * dump adds something a user acts on that isn't already there in a readable form.
     * The one case that legitimately needs more than the model's own facts (an
     * enumeration like "list every protocol address") is already handled by
     * `completeIdentifierFacts` merging the extra items directly into `structured.facts`
     * above, not by falling back to this raw dump — so dropping `data` here whenever
     * `structured` exists loses nothing, for any tool.
     */
    return {
      kind: "answer",
      message: prose,
      // Present only when the structured path succeeded. The UI renders this and falls
      // back to `message` when absent, so both paths stay usable.
      ...(structured ? { answer: structured } : {}),
      ...(structured ? {} : { data: factsForUi(data) }),
      intent: { template_id: routed.template_id, slots: built.args },
      mcp: {
        tool: routed.tool,
        simulation_success: true,
        has_unsigned_xdr: false,
      },
      request_id: ctx.request_id,
    };
  } catch (e) {
    // Health on large/active accounts often hits Soroban Budget ExceededLimit.
    // Fall back to collateral + debt reads so the user still gets real numbers.
    if (
      routed.tool === "vanna_get_account_health" &&
      e instanceof Error &&
      /Budget|ExceededLimit|resource/i.test(e.message)
    ) {
      // Prefer the SAME source the margin page renders. computeMarginSnapshot is what
      // /api/account serves, so using it here means the copilot and the margin page
      // cannot disagree about the number that decides liquidation. They did disagree:
      // MCP's vanna_get_collateral reported $214.72 of collateral where the page showed
      // $382.87 gross, which dragged the health factor to 1.95 against the page's 3.47.
      // Two different answers to "am I about to be liquidated" is worse than one slow
      // answer, so the shared calculation wins and the MCP probes stay as a last resort.
      if (ctx.smartAccount) {
        try {
          const [{ computeMarginSnapshot }, { HEALTH_FACTOR_INFINITY_SENTINEL }] =
            await Promise.all([
              import("@/lib/account-snapshot"),
              import("@/lib/margin-health"),
            ]);
          const snap = await computeMarginSnapshot(ctx.smartAccount);
          const hf = snap.avgHealthFactor;
          const parts = [
            "The protocol's health endpoint hit a Soroban CPU budget limit, so these come from the same on-chain read the margin page uses:",
            hf >= HEALTH_FACTOR_INFINITY_SENTINEL
              ? "health factor ∞ (no debt)"
              : `health factor ${hf.toFixed(2)}`,
            `collateral $${snap.grossCollateralValue.toFixed(2)}`,
            `borrowed $${snap.totalBorrowedValue.toFixed(2)}`,
            `$${snap.collateralLeftBeforeLiquidation.toFixed(2)} of collateral left before liquidation`,
          ];
          return {
            kind: "answer",
            message: parts.join(" · "),
            data: factsForUi({
              health_factor: hf,
              collateral_usd: snap.grossCollateralValue,
              debt_usd: snap.totalBorrowedValue,
              collateral_left_before_liquidation: snap.collateralLeftBeforeLiquidation,
              net_available_collateral: snap.netAvailableCollateral,
              note: "on_chain_snapshot_fallback",
            }),
            intent: {
              template_id: "query_account_health",
              slots: { mode: "margin_snapshot_fallback" },
            },
            mcp: { tool: "computeMarginSnapshot", has_unsigned_xdr: false },
            request_id: ctx.request_id,
          };
        } catch (snapErr) {
          console.warn(
            `[copilot] margin snapshot fallback failed -> ${snapErr instanceof Error ? snapErr.message.slice(0, 160) : String(snapErr)}`,
          );
        }
      }

      try {
        const mcp = getMcpClient();
        const sa = ctx.smartAccount;
        const probe = async (tool: string) => {
          try {
            const r = await mcp.call(tool, sa ? { smart_account: sa } : {}, ctx.userId);
            const p = r as Record<string, unknown> | null;
            // An error payload is a successful response here, so check for it rather
            // than relying on a rejection that never comes.
            if (p?.error) {
              console.warn(`[copilot] health fallback: ${tool} -> ${String(p.message ?? p.error).slice(0, 160)}`);
              return null;
            }
            return r;
          } catch (err) {
            console.warn(
              `[copilot] health fallback: ${tool} threw -> ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
            );
            return null;
          }
        };
        // Sequential, not Promise.all. These share one reused MCP session, and firing
        // both at once had vanna_get_collateral — the heavier of the two, it walks every
        // collateral token plus LP positions — abort on timeout while debt returned
        // fine. The same call succeeds on its own, so the concurrency is the problem,
        // not the call. This path is already degraded; correctness beats latency here.
        const debt = await probe("vanna_get_debt");
        const col = await probe("vanna_get_collateral");
        const colUsd = usdTotal(col, "collateral");
        const debtUsd = usdTotal(debt, "debt");
        const hf =
          colUsd != null && debtUsd != null && debtUsd > 0.01
            ? colUsd / debtUsd
            : colUsd != null && colUsd > 0
              ? 999
              : null;
        const parts = [
          "Full health endpoint hit a Soroban CPU budget limit on this account — using collateral + debt instead:",
        ];
        // Name what is missing. Omitting a component silently made the line read as a
        // complete picture when it was half of one.
        parts.push(colUsd != null ? `collateral ~$${colUsd.toFixed(2)}` : "collateral unavailable");
        parts.push(debtUsd != null ? `debt ~$${debtUsd.toFixed(2)}` : "debt unavailable");
        if (hf != null) {
          parts.push(
            hf >= 999
              ? "health factor ∞ (no meaningful debt)"
              : // Health factor IS gross collateral / debt — see lib/margin-health.ts,
                // which is checked against the protocol math reference. There is no
                // liquidation-threshold haircut on the collateral side; the threshold
                // (1.1) is the level HF is compared against, not a multiplier. This
                // figure can still differ from the margin page when MCP's collateral
                // view is incomplete, which is why the snapshot path above is preferred.
                `health factor ~${hf.toFixed(2)} (collateral ÷ debt; liquidation at 1.1)`,
          );
        }
        return {
          kind: "answer",
          message: parts.join(" · "),
          data: factsForUi({
            collateral: col,
            debt,
            approx_health_factor: hf,
            note: "fallback_from_budget_exceeded",
          }),
          intent: { template_id: "query_account_health", slots: { mode: "collateral_debt_fallback" } },
          mcp: { tool: "vanna_get_collateral+vanna_get_debt", has_unsigned_xdr: false },
          request_id: ctx.request_id,
        };
      } catch {
        /* fall through */
      }
    }
    return mcpErrorResponse(e, ctx.request_id, routed.template_id);
  }
}
