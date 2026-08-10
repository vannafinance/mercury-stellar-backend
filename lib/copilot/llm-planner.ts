/**
 * LLM strategy planner — plan-then-execute without free tool roulette.
 *
 * Architecture (Coinbase AgentKit / Anthropic workflow style):
 *   Planner (LLM JSON) → validated legs → MultiLegAgent executor (MCP tools)
 *
 * Keywords/extractors remain as fallbacks. The model is free-form understanding;
 * the allowlist + sanitize are the safety rails (not hard-coded user phrases).
 */

import { generateText, VertexError } from "./vertex";
import { sanitizePlan } from "./plan-sanitize";
import type { RoutedIntent } from "./types";

/**
 * JSON plan via generateText (public Vertex API).
 * Avoids importing generateJson — Turbopack sometimes fails to resolve that
 * export from the large vertex module even when it is present.
 */
async function planJson(system: string, user: string): Promise<Record<string, unknown>> {
  const out = await generateText(
    `${system}\n\nIMPORTANT: Reply with one JSON object only. No markdown fences, no prose.`,
    user,
    { temperature: 0 },
  );
  const cleaned = out
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const data = JSON.parse(cleaned);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("not a JSON object");
    }
    return data as Record<string, unknown>;
  } catch {
    throw new VertexError(`Planner JSON parse failed: ${cleaned.slice(0, 400)}`);
  }
}

const ALLOWED_OPS = new Set([
  "lend",
  "redeem",
  "deposit_collateral",
  "withdraw_collateral",
  "borrow",
  "repay",
  "swap",
  "deploy_to_blend",
  "supply_to_blend",
  "deposit_and_borrow",
  "create_account",
  "add_liquidity",
  "remove_liquidity",
]);

const PLANNER_SYSTEM = `You are Vanna Finance strategy planner for Stellar DeFi.
Your only job: convert the user message into an ordered JSON plan of write steps.
Execution happens elsewhere (MCP tools). You do NOT invent balances, APYs, or tx hashes.
DOMAIN: Vanna Finance only (Earn, Farm, Margin, swap, wallet). Refuse non-DeFi/coding in summary if somehow asked — prefer empty steps.

Respond ONLY with JSON:
{
  "kind": "plan",
  "summary": "one line",
  "steps": [
    {
      "kind": "write",
      "op": "<allowed op>",
      "asset": "XLM|BLUSDC|AQUSDC|SOUSDC|USDC|null",
      "amount": number|null,
      "leverage": number|null,
      "args": { "token_in"?: string, "token_out"?: string, "leverage"?: number }
    }
  ]
}

Allowed ops only:
lend, redeem, deposit_collateral, withdraw_collateral, borrow, repay, swap,
deploy_to_blend, supply_to_blend, deposit_and_borrow, create_account, add_liquidity, remove_liquidity

STRATEGY VOCABULARY — named strategies you must decompose yourself:

"delta-neutral carry" / "carry trade" / "basis trade" / "cash and carry" on asset X:
  The user wants yield without price exposure to X. Achieved by owing X and holding
  the same amount of X, so the two cancel:
    1. deposit_collateral with the STABLE asset the user named (their USDC variant)
    2. borrow X  ← this creates the short leg
    3. lend X (Vanna earn) or deploy_to_blend X  ← the long leg, and where yield comes from
  Borrow and deploy the SAME amount of X — that is what makes it delta-neutral. The
  profit is the deploy yield minus the borrow cost, not price movement.
  "delta-neutral XLM carry with 1,000 USDC" → deposit_collateral USDC 1000, then
  borrow XLM, then lend XLM the same amount.

"leveraged farm" / "lever up and farm" on asset X:
  deposit_collateral X, borrow X, deploy_to_blend X — or a single deploy_to_blend with
  leverage set, which the executor expands.

"loop" / "recursive borrow": repeat deposit → borrow on the same asset. Never emit more
  than 3 iterations.

Rules:
1. Preserve USER ORDER of actions (then / and then / after).
2. Amounts ONLY from explicit "N ASSET" (e.g. 20 XLM, 10 BLUSDC). Never invent.
3. "keep HF above 1.4" is a constraint — NOT an amount. Never set amount=1.4 from that.
4. "farm Blend at 2x with 10 BLUSDC" → one step op=deploy_to_blend asset=BLUSDC amount=10 leverage=2
   (executor expands to deposit→borrow→supply).
5. "park/lend 20 XLM for yield" → lend XLM 20.
6. "swap 10 XLM to BLUSDC" → swap with args.token_in=XLM args.token_out=BLUSDC amount=10.
7. Single action → still kind=plan with one step (executor handles both single and multi).
8. If unclear → still best-effort plan; missing amount stays null.
9. Never use tools. JSON only.`;

function normalizeLlmPlan(data: Record<string, unknown>, message: string): RoutedIntent | null {
  if (String(data.kind) !== "plan" || !Array.isArray(data.steps)) return null;
  const steps = (data.steps as any[])
    .map((s) => {
      const op = String(s.op || "").toLowerCase();
      if (!ALLOWED_OPS.has(op)) return null;
      const args: Record<string, unknown> =
        s.args && typeof s.args === "object" && !Array.isArray(s.args) ? { ...s.args } : {};
      const lev =
        s.leverage != null && Number.isFinite(Number(s.leverage))
          ? Number(s.leverage)
          : args.leverage != null
            ? Number(args.leverage)
            : null;
      if (lev != null && lev > 1) args.leverage = lev;
      if (s.token_in) args.token_in = String(s.token_in).toUpperCase();
      if (s.token_out) args.token_out = String(s.token_out).toUpperCase();
      if (args.token_in && !args.token_a) args.token_a = args.token_in;
      if (args.token_out && !args.token_b) args.token_b = args.token_out;
      const amount =
        s.amount != null && s.amount !== "" && Number.isFinite(Number(s.amount))
          ? Number(s.amount)
          : null;
      return {
        kind: "write" as const,
        op,
        asset: s.asset != null ? String(s.asset).toUpperCase() : null,
        amount: amount != null && amount > 0 ? amount : null,
        args: Object.keys(args).length ? args : undefined,
        leverage: lev,
      };
    })
    .filter(Boolean) as Extract<RoutedIntent, { kind: "plan" }>["steps"];

  if (!steps.length) return null;

  const plan: Extract<RoutedIntent, { kind: "plan" }> = {
    kind: "plan",
    template_id: "llm_strategy_plan",
    summary:
      data.summary != null
        ? String(data.summary)
        : `Strategy: ${steps.map((s) => s.op).join(" → ")}`,
    steps,
  };
  return sanitizePlan(plan, message);
}

/**
 * One planner call per message, however many times it is asked for.
 *
 * `handleChat` asks twice on purpose — once when the routed intent is already a plan, and
 * again as a late catch when a single write might still be promoted. Both branches can be
 * reached in one turn: if the first call returns null (or a plan that loses the length
 * comparison) `routed` is still a write, so the second fires with the SAME message and the
 * same context, and Vertex is billed twice for an identical prompt. The planner is the most
 * expensive call in the turn — measured at ~950 prompt plus 400–1800 THINKING tokens, and
 * thinking bills at output rates — so a duplicate is the single easiest thing to stop
 * paying for.
 *
 * Keyed by message + context, capped, and cleared on a timer rather than held for the life
 * of the process: this is a within-turn memo, not a cache of answers across users. A stale
 * plan replayed for a later turn would be a correctness bug, so the window is deliberately
 * short — long enough for one request, far too short to serve a second visit.
 */
const PLAN_MEMO_TTL_MS = 30_000;
const PLAN_MEMO_MAX = 64;
const planMemo = new Map<string, { at: number; plan: RoutedIntent | null }>();

function memoKey(message: string, ctx?: { trader?: string | null; smartAccount?: string | null }) {
  return `${ctx?.trader ?? "-"}|${ctx?.smartAccount ?? "-"}|${message.trim()}`;
}

/** Test/debug hook: how many planner calls were actually spent vs served from memo. */
export const plannerStats = { calls: 0, memoHits: 0 };

export function resetPlannerMemo(): void {
  planMemo.clear();
  plannerStats.calls = 0;
  plannerStats.memoHits = 0;
}

/**
 * Ask Vertex for a structured strategy plan. Returns null if model fails or invalid.
 */
export async function llmPlanStrategy(
  message: string,
  ctx?: { trader?: string | null; smartAccount?: string | null },
): Promise<RoutedIntent | null> {
  const key = memoKey(message, ctx);
  const now = Date.now();
  const hit = planMemo.get(key);
  if (hit && now - hit.at < PLAN_MEMO_TTL_MS) {
    plannerStats.memoHits += 1;
    return hit.plan;
  }
  const remember = (plan: RoutedIntent | null): RoutedIntent | null => {
    planMemo.set(key, { at: now, plan });
    // Cheap bound: drop the oldest insertion when over cap.
    if (planMemo.size > PLAN_MEMO_MAX) {
      const oldest = planMemo.keys().next();
      if (!oldest.done) planMemo.delete(oldest.value);
    }
    return plan;
  };

  plannerStats.calls += 1;
  try {
    const user = [
      `USER MESSAGE: ${message}`,
      `CONTEXT: trader=${ctx?.trader ?? "unknown"} smart_account=${ctx?.smartAccount ?? "unknown"}`,
      "Output the plan JSON only.",
    ].join("\n");
    const data = await planJson(PLANNER_SYSTEM, user);
    return remember(normalizeLlmPlan(data, message));
  } catch (e) {
    console.warn(
      "[copilot:llm-planner]",
      e instanceof VertexError ? e.message : e instanceof Error ? e.message : e,
    );
    // A failure is memoised too. Retrying the same prompt inside one turn produced the
    // same failure and a second bill; the caller already treats null as "keep what I had".
    return remember(null);
  }
}

/** When to call the LLM planner (complex / multi-leg / long free-form). */
export function shouldLlmPlan(message: string): boolean {
  const t = message.trim();
  if (t.length < 12) return false;
  if (t.length > 70) return true;
  const verbs =
    t.match(
      /\b(swap|lend|borrow|deposit|repay|farm|supply|withdraw|redeem|park|deploy|invest)\b/gi,
    ) || [];
  if (new Set(verbs.map((v) => v.toLowerCase())).size >= 2) return true;
  if (/\b(then|and then|after that|multi[- ]?step|strategy|while|keeping)\b/i.test(t)) return true;
  if (/\bfarm\b/i.test(t) && /\b\d+\s*x\b/i.test(t)) return true;
  return false;
}
