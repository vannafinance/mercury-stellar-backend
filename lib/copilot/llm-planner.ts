/**
 * LLM strategy planner — plan-then-execute without free tool roulette.
 *
 * Architecture (Coinbase AgentKit / Anthropic workflow style):
 *   Planner (LLM JSON) → validated legs → MultiLegAgent executor (MCP tools)
 *
 * Keywords/extractors remain as fallbacks. The model is free-form understanding;
 * the allowlist + sanitize are the safety rails (not hard-coded user phrases).
 */

import { generateJson, VertexError } from "./vertex";
import { sanitizePlan } from "./plan-sanitize";
import type { RoutedIntent } from "./types";

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
 * Ask Vertex for a structured strategy plan. Returns null if model fails or invalid.
 */
export async function llmPlanStrategy(
  message: string,
  ctx?: { trader?: string | null; smartAccount?: string | null },
): Promise<RoutedIntent | null> {
  try {
    const user = [
      `USER MESSAGE: ${message}`,
      `CONTEXT: trader=${ctx?.trader ?? "unknown"} smart_account=${ctx?.smartAccount ?? "unknown"}`,
      "Output the plan JSON only.",
    ].join("\n");
    const data = await generateJson(PLANNER_SYSTEM, user);
    return normalizeLlmPlan(data, message);
  } catch (e) {
    console.warn(
      "[copilot:llm-planner]",
      e instanceof VertexError ? e.message : e instanceof Error ? e.message : e,
    );
    return null;
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
