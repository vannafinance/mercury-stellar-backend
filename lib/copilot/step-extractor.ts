/**
 * Deterministic ordered-step extraction for long multi-leg user prompts.
 *
 * Industry pattern (LangChain plan-then-execute, Anthropic fixed workflows):
 *   1) Decompose the user goal into an ordered plan (this module)
 *   2) Execute each step with tools (MultiLegAgent + MCP)
 *   3) Observe (HF / status) between steps
 *
 * This is NOT free-form tool roulette — Vanna maps only to known ops.
 */

import type { RoutedIntent } from "./types";
import { parseMinHealthFactor } from "./router";

export type ExtractedStep = {
  kind: "write";
  op: string;
  asset?: string | null;
  amount?: number | null;
  leverage?: number | null;
  args?: Record<string, unknown>;
};

const ASSET = "BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA|EURC";
const AMT_ASSET = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${ASSET})\\b`, "i");
const LEVERAGE = /(\d+(?:\.\d+)?)\s*x\b/i;

function firstAmtAsset(clause: string): { amount: number; asset: string } | null {
  const m = clause.match(AMT_ASSET);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, asset: m[2].toUpperCase() };
}

function allAmtAssets(clause: string): Array<{ amount: number; asset: string }> {
  const out: Array<{ amount: number; asset: string }> = [];
  const re = new RegExp(AMT_ASSET.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(clause)) !== null) {
    const amount = Number(m[1]);
    if (Number.isFinite(amount) && amount > 0) out.push({ amount, asset: m[2].toUpperCase() });
  }
  return out;
}

function lev(clause: string, globalLev: number | null): number | null {
  const m = clause.match(LEVERAGE);
  if (m && Number.isFinite(Number(m[1]))) return Number(m[1]);
  return globalLev;
}

/**
 * Split long prompts into ordered clauses on then / after / next / ;
 * Keeps multi-sentence strategies intact.
 */
export function splitStrategyClauses(message: string): string[] {
  const raw = message.trim();
  if (!raw) return [];
  // Split on sequence markers (keep content)
  const parts = raw
    .split(/\b(?:and\s+then|then|after\s+that|afterwards|next|finally|;)\b/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 2);
  return parts.length ? parts : [raw];
}

/**
 * Map one natural-language clause to a single write op when possible.
 */
export function clauseToStep(
  clause: string,
  global: { leverage: number | null; minHf: number | null },
): ExtractedStep | null {
  const t = clause.toLowerCase();
  const pairs = allAmtAssets(clause);
  const first = pairs[0] || firstAmtAsset(clause);
  const L = lev(clause, global.leverage);

  // Constraints only (HF) — not a write
  if (
    /\b(keep|maintain|hold|above|health|hf|liquidat)\b/i.test(t) &&
    !/\b(lend|park|farm|swap|deposit|borrow|repay|redeem|supply|deploy)\b/i.test(t)
  ) {
    return null;
  }

  // Swap A → B
  if (/\bswap\b/i.test(t)) {
    const sm = clause.match(
      new RegExp(
        `(\\d+(?:\\.\\d+)?)\\s*(${ASSET})\\b.*?\\b(?:to|for|into)\\s*(${ASSET})\\b`,
        "i",
      ),
    );
    if (sm) {
      const tokenIn = sm[2].toUpperCase();
      const tokenOut = sm[3].toUpperCase();
      return {
        kind: "write",
        op: "swap",
        asset: tokenIn,
        amount: Number(sm[1]),
        args: { token_in: tokenIn, token_out: tokenOut, token_a: tokenIn, token_b: tokenOut },
      };
    }
    if (first) {
      return { kind: "write", op: "swap", asset: first.asset, amount: first.amount };
    }
  }

  // Farm / Blend / levered deploy
  if (/\b(farm|blend|deploy)\b/i.test(t) && !/\b(stats|apy|position)\b/i.test(t)) {
    const farmPair =
      pairs.find((p) => p.asset !== "XLM") ||
      pairs[0] ||
      first;
    return {
      kind: "write",
      op: "deploy_to_blend",
      asset: farmPair?.asset || "BLUSDC",
      amount: farmPair?.amount ?? null,
      leverage: L != null && L > 1 ? L : 2,
      args: { leverage: L != null && L > 1 ? L : 2 },
    };
  }

  // Park / lend / earn
  if (/\b(park|lend|earn\s+yield|for\s+yield|supply\s+to\s+earn)\b/i.test(t)) {
    const xlm = pairs.find((p) => p.asset === "XLM") || first;
    return {
      kind: "write",
      op: "lend",
      asset: xlm?.asset || "XLM",
      amount: xlm?.amount ?? null,
    };
  }

  // Deposit + borrow in same clause
  if (/\bdeposit\b/i.test(t) && /\bborrow\b/i.test(t)) {
    return {
      kind: "write",
      op: "deposit_and_borrow",
      asset: first?.asset || "XLM",
      amount: first?.amount ?? null,
      leverage: L != null && L > 1 ? L : 2,
      args: { leverage: L != null && L > 1 ? L : 2 },
    };
  }

  if (/\bdeposit\b/i.test(t) && !/\bpool|earn|vault\b/i.test(t)) {
    return {
      kind: "write",
      op: "deposit_collateral",
      asset: first?.asset || "XLM",
      amount: first?.amount ?? null,
    };
  }

  if (/\bborrow\b/i.test(t) && !/\bcan\s+i\s+borrow\b/i.test(t)) {
    return {
      kind: "write",
      op: "borrow",
      asset: first?.asset || "USDC",
      amount: first?.amount ?? null,
    };
  }

  if (/\brepay\b/i.test(t)) {
    return {
      kind: "write",
      op: "repay",
      asset: first?.asset || "USDC",
      amount: first?.amount ?? null,
    };
  }

  if (/\bredeem\b/i.test(t) || (/\bwithdraw\b/i.test(t) && /\b(earn|pool|supply)\b/i.test(t))) {
    return {
      kind: "write",
      op: "redeem",
      asset: first?.asset || "XLM",
      amount: first?.amount ?? null,
    };
  }

  if (/\bsupply\b/i.test(t) && /\bblend\b/i.test(t)) {
    return {
      kind: "write",
      op: "supply_to_blend",
      asset: first?.asset || "BLUSDC",
      amount: first?.amount ?? null,
    };
  }

  return null;
}

/**
 * Extract an ordered multi-leg plan from free-form English.
 * Returns null if fewer than 2 write steps (not multi-leg).
 */
export function extractOrderedPlan(message: string): Extract<RoutedIntent, { kind: "plan" }> | null {
  const minHf = parseMinHealthFactor(message);
  const leverageM = message.match(LEVERAGE);
  const globalLev =
    leverageM && Number.isFinite(Number(leverageM[1])) ? Number(leverageM[1]) : null;

  const clauses = splitStrategyClauses(message);
  const steps: ExtractedStep[] = [];

  for (const clause of clauses) {
    const step = clauseToStep(clause, { leverage: globalLev, minHf });
    if (!step) continue;
    // Drop HF-floor-as-amount
    if (
      step.amount != null &&
      minHf != null &&
      Math.abs(step.amount - minHf) < 1e-9 &&
      !new RegExp(`${step.amount}\\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM)`, "i").test(message)
    ) {
      step.amount = null;
    }
    steps.push(step);
  }

  // Deduplicate consecutive identical ops
  const deduped = steps.filter((s, i, arr) => {
    if (i === 0) return true;
    const p = arr[i - 1];
    return !(s.op === p.op && s.asset === p.asset && s.amount === p.amount);
  });

  if (deduped.length < 2) return null;

  const parts = deduped.map((s, i) => {
    const a = s.amount != null ? `${s.amount} ` : "";
    const L = s.leverage != null && s.leverage > 1 ? ` at ${s.leverage}×` : "";
    const to =
      s.op === "swap" && s.args?.token_out ? `→${s.args.token_out}` : s.asset || "";
    return `${i + 1}) ${s.op} ${a}${to}${L}`.trim();
  });

  return {
    kind: "plan",
    template_id: "extracted_multi_goal",
    summary: `Multi-step strategy: ${parts.join(" → ")}`,
    steps: deduped.map((s) => ({
      kind: "write" as const,
      op: s.op,
      asset: s.asset ?? null,
      amount: s.amount ?? null,
      args: s.args,
      leverage: s.leverage ?? null,
    })),
  };
}

/**
 * Merge extracted ordered steps into a routed plan (fill missing amounts/ops).
 * Prefer extracted order when both are multi-step (clause order = user order).
 */
export function preferExtractedPlan(
  routed: RoutedIntent,
  message: string,
): RoutedIntent {
  const extracted = extractOrderedPlan(message);
  if (!extracted || extracted.steps.length < 2) return routed;

  if (routed.kind !== "plan") {
    return extracted;
  }

  const rWrites = routed.steps.filter((s) => s.kind === "write");
  // Prefer extracted when it has more legs or clearer swap token_out
  const hasSwapOut = extracted.steps.some(
    (s) => s.op === "swap" && s.args?.token_out,
  );
  const routedSwapBare =
    rWrites.some((s) => s.op === "swap") &&
    !rWrites.some((s) => s.op === "swap" && s.args?.token_out);

  if (extracted.steps.length >= rWrites.length || (hasSwapOut && routedSwapBare)) {
    return extracted;
  }

  // Fill gaps: for each routed write missing amount, take from extracted same op
  const byOp = new Map(
    extracted.steps.filter((s) => s.op).map((s) => [s.op!, s] as const),
  );
  const steps = routed.steps.map((s) => {
    if (s.kind !== "write" || !s.op) return s;
    const ex = byOp.get(s.op);
    if (!ex) return s;
    return {
      ...s,
      amount: s.amount != null && s.amount > 0 ? s.amount : ex.amount,
      asset: s.asset || ex.asset,
      args: { ...(ex.args || {}), ...(s.args || {}) },
      leverage: s.leverage ?? ex.leverage ?? null,
    };
  });

  return { ...routed, steps };
}
