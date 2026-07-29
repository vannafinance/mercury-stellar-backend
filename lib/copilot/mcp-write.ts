/**
 * Map copilot write ops → live MCP tools, then optionally auto-sign via Sign Service.
 *
 * Risk / HF / caps are enforced by MCP + Sign Service — not by this layer.
 */

import type { MCPClient } from "./mcp-client";
import type { AccountCtx } from "./tool-args";

/** Earn pools that exist on testnet Registry (Sanujit PDF + MCP docs). */
export const EARN_POOL_SYMBOLS = ["XLM", "USDC", "BLUSDC", "AQUSDC", "SOUSDC", "AQUARIUS_USDC", "SOROSWAP_USDC"] as const;

/** Minimum human amount we'll attempt to lend (reject dust / zero / negative). */
const MIN_LEND_AMOUNT = 1e-6;

export interface WriteStep {
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

export interface McpWriteResult {
  tool: string;
  label: string;
  build: Record<string, unknown>;
  unsigned_xdr?: string | null;
  submitted?: Record<string, unknown> | null;
  status:
    | "built"
    | "signed_and_submitted"
    | "needs_auto_sign"
    | "needs_wallet_sign"
    | "rejected"
    | "error"
    | "done";
  message: string;
  /** Always set so the UI can prove MCP was used */
  mcp_trace: {
    tool: string;
    simulation_success?: boolean;
    auto_sign?: string | null;
    auto_sign_error?: string | null;
    has_unsigned_xdr: boolean;
  };
}

function pickXdr(data: Record<string, unknown>): string | null {
  for (const k of ["unsigned_xdr", "xdr", "envelope_xdr", "transaction"]) {
    const v = data[k];
    if (typeof v === "string" && v.length > 20) return v;
  }
  return null;
}

function looksG(a?: string | null): a is string {
  return !!a && /^G[A-Z0-9]{55}$/.test(a);
}
function looksC(a?: string | null): a is string {
  return !!a && /^C[A-Z0-9]{55}$/.test(a);
}

/**
 * Margin collateral symbols on this deploy (AccountManager allowlist):
 * XLM, BLUSDC, AQUSDC, SOUSDC — plain "USDC" is NOT allowed as collateral.
 * Earn pool "USDC" maps to BLUSDC for margin deposit/borrow.
 */
export function marginCollateralSymbol(asset?: string | null): string {
  const a = (asset || "USDC").toUpperCase();
  if (a === "USDC" || a === "BLEND_USDC" || a === "BLUSDC") return "BLUSDC";
  if (a === "AQUARIUS_USDC" || a === "AQUSDC") return "AQUSDC";
  if (a === "SOROSWAP_USDC" || a === "SOUSDC") return "SOUSDC";
  return a;
}

/** 2× leverage with deposit D → borrow D*(L-1). Caps borrow so post-tx LTV stays under ~85% of liq threshold. */
export function splitLeverageAmounts(
  deposit: number,
  leverage?: number | null,
  borrowExplicit?: number | null,
): { deposit: number; borrow: number } {
  if (borrowExplicit != null && borrowExplicit > 0) {
    return { deposit, borrow: borrowExplicit };
  }
  const lev = leverage != null && leverage > 1 ? leverage : 2;
  // Classic 2x: deposit D, borrow D. Keep a small safety haircut vs 0.909 liq LTV.
  const rawBorrow = deposit * (lev - 1);
  const maxSafe = deposit * 0.8; // leave headroom after deposit
  return { deposit, borrow: Math.min(rawBorrow, maxSafe) };
}

/** Normalize earn-pool symbols the way MCP does (USDC → BLUSDC pool alias). */
export function earnPoolSymbol(asset?: string | null): string {
  const a = (asset || "USDC").toUpperCase();
  if (a === "AQUARIUS_USDC") return "AQUSDC";
  if (a === "SOROSWAP_USDC") return "SOUSDC";
  if (a === "BLEND_USDC") return "BLUSDC";
  return a;
}

function isSupportedEarnSymbol(symbol: string): boolean {
  const s = earnPoolSymbol(symbol);
  return (EARN_POOL_SYMBOLS as readonly string[]).includes(s) || s === "USDC" || s === "BLUSDC";
}

/**
 * Parse wallet balance for a lend symbol from vanna_get_wallet_balance.
 * USDC earn uses the BLUSDC SAC on this deploy — plain USDC is not resolvable.
 */
export function walletBalanceForEarn(
  walletData: Record<string, unknown>,
  symbol: string,
): { balance: number; symbolUsed: string; lines: string[] } {
  const want = earnPoolSymbol(symbol).toUpperCase();
  // Prefer exact match; for USDC also accept BLUSDC (and show both if present).
  const candidates =
    want === "USDC" || want === "BLUSDC"
      ? ["BLUSDC", "USDC"]
      : want === "XLM"
        ? ["XLM", "XLM_SAC"]
        : [want];

  const assets = Array.isArray(walletData.assets) ? (walletData.assets as Record<string, unknown>[]) : [];
  const lines: string[] = [];
  let best = 0;
  let symbolUsed = want;

  for (const row of assets) {
    const sym = String(row.symbol || "").toUpperCase();
    const status = String(row.status || "");
    const bal =
      typeof row.balance === "number"
        ? row.balance
        : typeof row.balance === "string"
          ? Number(row.balance)
          : NaN;
    if (status === "ok" && Number.isFinite(bal)) {
      lines.push(`${sym}: ${bal}`);
    }
    if (candidates.includes(sym) && status === "ok" && Number.isFinite(bal) && bal > best) {
      best = bal;
      symbolUsed = sym === "XLM_SAC" ? "XLM" : sym;
    }
  }
  return { balance: best, symbolUsed, lines };
}

/**
 * Static lend checks (no network): amount, dust, unsupported asset.
 * Returns a user-facing blocker or null if OK to proceed to balance preflight.
 */
export function validateLendParams(params: {
  asset?: string | null;
  amount?: number | null;
  trader?: string | null;
}): string | null {
  if (!looksG(params.trader)) return "Connect your wallet to lend into an earn pool.";
  const symbol = earnPoolSymbol(params.asset);
  if (!isSupportedEarnSymbol(symbol)) {
    return (
      `“${(params.asset || "").toUpperCase() || "that asset"}” is not a Vanna earn pool. ` +
      `Supported: XLM, USDC (BLUSDC), AQUSDC, SOUSDC.`
    );
  }
  const amt = params.amount;
  if (amt == null || !(typeof amt === "number") || !Number.isFinite(amt)) {
    return null; // missing amount handled separately (may include live APY)
  }
  if (amt <= 0) {
    return `Amount must be positive — “${amt}” is not valid. e.g. “supply 10 ${symbol}”.`;
  }
  if (amt <= MIN_LEND_AMOUNT) {
    return (
      `That amount (${amt} ${symbol}) is dust — at or below the minimum ${MIN_LEND_AMOUNT}. ` +
      `Try a larger figure, e.g. “supply 1 ${symbol}”.`
    );
  }
  return null;
}

/**
 * Live preflight before vanna_lend: quote wallet balance and block over-balance
 * (Sanujit EW6: "Blocked with the actual wallet balance quoted. No unsigned tx").
 */
export async function preflightLend(
  mcp: MCPClient,
  params: { asset?: string | null; amount: number; trader: string },
  userId?: string,
): Promise<{ ok: true; poolSymbol: string; balance: number } | { ok: false; blocker: string }> {
  const staticBlock = validateLendParams({ ...params, trader: params.trader });
  if (staticBlock) return { ok: false, blocker: staticBlock };

  const poolSymbol = earnPoolSymbol(params.asset);
  // MCP accepts USDC as alias; keep that for the tool call.
  const toolSymbol = poolSymbol === "BLUSDC" ? "USDC" : poolSymbol;

  try {
    const wallet = await mcp.call("vanna_get_wallet_balance", { g_address: params.trader }, userId);
    const { balance, symbolUsed, lines } = walletBalanceForEarn(wallet, poolSymbol);
    if (params.amount > balance + 1e-9) {
      const feeNote =
        poolSymbol === "XLM" || symbolUsed === "XLM"
          ? ` Leave ~${wallet.fee_reserve_xlm ?? "0.5"} XLM free for fees.`
          : "";
      return {
        ok: false,
        blocker:
          `You asked to supply ${params.amount} ${toolSymbol}, but your wallet only has ` +
          `**${balance} ${symbolUsed}** available for that earn pool.${feeNote}\n` +
          (lines.length ? `Wallet lines: ${lines.slice(0, 6).join(" · ")}.` : "") +
          `\nNo transaction was built — try a smaller amount.`,
      };
    }
    return { ok: true, poolSymbol: toolSymbol, balance };
  } catch {
    // Balance read failed — still allow MCP lend; simulation will catch it.
    return { ok: true, poolSymbol: toolSymbol, balance: Number.POSITIVE_INFINITY };
  }
}

/** Map high-level op → MCP tool + args (real server schemas). */
export function mapOpToMcpStep(
  op: string,
  params: {
    asset?: string | null;
    amount?: number | null;
    deposit_amount?: number | null;
    borrow_amount?: number | null;
    leverage?: number | null;
    token_a?: string | null;
    token_b?: string | null;
    amount_a?: number | null;
    amount_b?: number | null;
    /** Resolved Registry blend pool C-address for deploy_to_blend. */
    blend_pool_address?: string | null;
    /** enable_auto_sign only — Sign Service policy caps. */
    use_default_caps?: boolean | null;
    max_per_tx_usd?: number | string | null;
    max_per_day_usd?: number | string | null;
  },
  ctx: AccountCtx,
): { step?: WriteStep; blocker?: string } {
  const trader = looksG(ctx.trader) ? ctx.trader : null;
  const smart = looksC(ctx.smartAccount) ? ctx.smartAccount : null;
  const symbol = (params.asset || "USDC").toUpperCase();
  const amount =
    params.amount != null && params.amount > 0 ? String(params.amount) : null;

  switch (op) {
    case "create_account":
    case "open_account": {
      if (!trader) return { blocker: "Connect your wallet (G-address) to create a smart account." };
      return {
        step: {
          tool: "vanna_open_account",
          args: { trader },
          label: "Create smart account",
        },
      };
    }
    case "lend":
    case "supply": {
      if (!trader) return { blocker: "Connect your wallet to lend." };
      const staticBlock = validateLendParams({
        asset: params.asset,
        amount: params.amount,
        trader,
      });
      if (staticBlock) return { blocker: staticBlock };
      if (!amount) {
        const a = earnPoolSymbol(params.asset);
        return {
          blocker:
            `How much ${a} do you want to supply to the Vanna earn pool? ` +
            `e.g. “lend 10 ${a}” or “supply 25 ${a}”.`,
        };
      }
      // USDC earn pool is the BLUSDC Registry pool; MCP accepts "USDC" as alias.
      const toolSymbol = earnPoolSymbol(symbol) === "BLUSDC" ? "USDC" : earnPoolSymbol(symbol);
      return {
        step: {
          tool: "vanna_lend",
          args: { symbol: toolSymbol, amount, lender: trader },
          label: `Lend ${amount} ${toolSymbol}`,
        },
      };
    }
    case "redeem":
    case "withdraw_supply": {
      if (!trader) return { blocker: "Connect your wallet to redeem." };
      const args: Record<string, unknown> = { symbol, lender: trader };
      if (amount) args.amount = amount;
      else args.redeem_all = true;
      return {
        step: {
          tool: "vanna_redeem",
          args,
          label: amount ? `Redeem ${amount} ${symbol}` : `Redeem all ${symbol}`,
        },
      };
    }
    case "deposit_collateral": {
      if (!trader || !smart) {
        return { blocker: "Need wallet + smart account to deposit collateral." };
      }
      if (!amount) return { blocker: "How much collateral? e.g. “deposit 5 XLM as collateral”." };
      const collSym = marginCollateralSymbol(symbol);
      return {
        step: {
          tool: "vanna_deposit_collateral",
          args: { smart_account: smart, symbol: collSym, amount, trader },
          label: `Deposit ${amount} ${collSym} collateral`,
        },
      };
    }
    case "withdraw_collateral": {
      if (!trader || !smart) {
        return { blocker: "Need wallet + smart account to withdraw collateral." };
      }
      if (!amount) return { blocker: "How much collateral to withdraw?" };
      const collSym = marginCollateralSymbol(symbol);
      return {
        step: {
          tool: "vanna_withdraw_collateral",
          args: { smart_account: smart, symbol: collSym, amount, trader },
          label: `Withdraw ${amount} ${collSym} collateral`,
        },
      };
    }
    case "borrow": {
      if (!trader || !smart) return { blocker: "Need wallet + smart account to borrow." };
      if (!amount) return { blocker: "How much do you want to borrow?" };
      const borSym = marginCollateralSymbol(symbol);
      return {
        step: {
          tool: "vanna_borrow",
          args: { smart_account: smart, symbol: borSym, amount, trader },
          label: `Borrow ${amount} ${borSym}`,
        },
      };
    }
    case "repay": {
      if (!trader || !smart) return { blocker: "Need wallet + smart account to repay." };
      if (!amount) return { blocker: "How much do you want to repay?" };
      const repSym = marginCollateralSymbol(symbol);
      return {
        step: {
          tool: "vanna_repay",
          args: { smart_account: smart, symbol: repSym, amount, trader },
          label: `Repay ${amount} ${repSym}`,
        },
      };
    }
    case "deposit_and_borrow": {
      // Prefer sequential deposit → borrow (see runWrite). Combined MCP tool is kept
      // only as an explicit atomic fallback; its pre-flight ignores same-tx deposit.
      if (!trader || !smart) return { blocker: "Need wallet + smart account." };
      const dep = params.deposit_amount ?? params.amount;
      if (dep == null || dep <= 0) return { blocker: "How much to deposit for the leveraged position?" };
      const { borrow: bor } = splitLeverageAmounts(dep, params.leverage, params.borrow_amount);
      const collSym = marginCollateralSymbol(symbol);
      return {
        step: {
          tool: "vanna_deposit_and_borrow",
          args: {
            smart_account: smart,
            deposit_amount: String(dep),
            borrow_amount: String(bor),
            symbol: collSym,
            trader,
          },
          label: `Deposit ${dep} + borrow ${bor} ${collSym}`,
        },
      };
    }
    case "deploy_to_blend":
    case "supply_to_blend": {
      // Farm write: deposit from wallet into margin account and deploy into Blend.
      // Sanujit FW1 — source is the margin account; MCP tool is vanna_deploy_to_blend.
      if (!trader || !smart) {
        return { blocker: "Need wallet + smart account to supply to Blend. Create a margin account first." };
      }
      const dep = params.deposit_amount ?? params.amount;
      if (dep == null || dep <= 0) {
        return { blocker: "How much do you want to supply to Blend? e.g. “supply 10 XLM to Blend”." };
      }
      // Blend reserves are XLM or USDC (BLUSDC maps to USDC on Blend).
      const blendSym =
        symbol === "BLUSDC" || symbol === "USDC" || symbol === "AQUSDC" || symbol === "SOUSDC"
          ? "USDC"
          : "XLM";
      // Plain supply (no leverage): borrow 0. Levered farm uses leverage → borrow.
      let bor = 0;
      if (params.borrow_amount != null && params.borrow_amount > 0) {
        bor = params.borrow_amount;
      } else if (params.leverage != null && params.leverage > 1) {
        bor = splitLeverageAmounts(dep, params.leverage, null).borrow;
      }
      const totalIn = dep + bor;
      const blendPool = params.blend_pool_address;
      if (!blendPool || !looksC(blendPool)) {
        return {
          blocker:
            "Blend pool address is not configured yet — resolve it from the Registry first.",
        };
      }
      return {
        step: {
          tool: "vanna_deploy_to_blend",
          args: {
            smart_account: smart,
            deposit_amount: String(dep),
            borrow_amount: String(bor),
            token_symbol: blendSym,
            blend_pool_address: blendPool,
            blend_tokens_in: [blendSym],
            // Same-asset deposit into Blend reserve (not a swap).
            blend_tokens_out: [blendSym],
            blend_amounts_in: [String(totalIn > 0 ? totalIn : dep)],
            blend_amounts_out_min: ["0"],
            trader,
          },
          label:
            bor > 0
              ? `Deploy ${dep} + borrow ${bor} ${blendSym} to Blend`
              : `Supply ${dep} ${blendSym} to Blend`,
        },
      };
    }
    case "settle_account": {
      if (!trader || !smart) return { blocker: "Need wallet + smart account to settle." };
      return {
        step: {
          tool: "vanna_settle_account",
          args: { smart_account: smart, trader },
          label: "Settle account",
        },
      };
    }
    case "close_account": {
      if (!trader || !smart) return { blocker: "Need wallet + smart account to close." };
      return {
        step: {
          tool: "vanna_close_account",
          args: { smart_account: smart, trader },
          label: "Close smart account",
        },
      };
    }
    case "enable_auto_sign": {
      if (!trader) return { blocker: "Connect your wallet to enable auto-sign." };
      return {
        step: {
          tool: "vanna_enable_auto_sign",
          args: {
            wallet_address: trader,
            user_id: trader,
            ...(params.use_default_caps != null ? { use_default_caps: params.use_default_caps } : {}),
            ...(params.max_per_tx_usd != null ? { max_per_tx_usd: params.max_per_tx_usd } : {}),
            ...(params.max_per_day_usd != null ? { max_per_day_usd: params.max_per_day_usd } : {}),
          },
          label: "Enable auto-sign",
        },
      };
    }
    case "disable_auto_sign": {
      if (!trader) return { blocker: "Connect your wallet." };
      return {
        step: {
          tool: "vanna_disable_auto_sign",
          args: { wallet_address: trader },
          label: "Disable auto-sign",
        },
      };
    }
    default:
      return { blocker: `Write op “${op}” is not mapped to an MCP tool yet.` };
  }
}

/**
 * Contract-level WAD integer → human units, as a string (no BigInt: the project
 * targets below ES2020, so BigInt literals don't compile).
 */
function wadToHuman(raw: string): string {
  const whole = raw.length > 18 ? raw.slice(0, raw.length - 18) : "0";
  const frac = raw.slice(Math.max(0, raw.length - 18)).padStart(18, "0").replace(/0+$/, "").slice(0, 6);
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * MCP surfaces raw WAD integers in its own error text — "deposit_and_borrow of
 * 20000000000000000000 USDC …" — because that's the value it hands the contract.
 * Rewrite those runs into human units so the user reads "20 USDC". Only 19+ digit
 * runs are touched: real WAD amounts are that long, while ledger numbers (~7) and
 * unix timestamps (10–13) are not, so addresses and IDs are left alone.
 */
function humanizeWadAmounts(message: string): string {
  return message.replace(/\b\d{19,}\b/g, (raw) => wadToHuman(raw));
}

/**
 * Does this MCP error represent the deterministic risk gate saying no, rather than
 * something being broken?
 *
 * `health_check_failed` is the MCP server's own taxonomy for "account LTV is too
 * high for this operation" (mcp_server/error_handling.py), raised by the
 * `is_borrow_allowed` pre-flight before any XDR is built. It's a policy decision,
 * so it belongs in the UI's blocked/risk-gate state — surfacing it as a generic
 * error made a working safety check look like a crash.
 */
function isRiskRejection(build: Record<string, unknown>): boolean {
  const code = String(build.error ?? "").toLowerCase();
  const msg = String(build.message ?? "");
  return (
    code === "health_check_failed" ||
    code === "unhealthy_account" ||
    /rejected by risk engine pre-flight|risk engine|ltv is too high|health factor/i.test(msg)
  );
}

/**
 * Turn raw MCP simulation dumps (Contract #3 balance failures, WAD amounts) into
 * a short plain-English note so the UI does not dump the full diagnostic log.
 */
export function humanizeMcpWriteError(build: Record<string, unknown>, tool: string): string {
  const code = String(build.error ?? "").toLowerCase();
  const raw = humanizeWadAmounts(String(build.message || build.error || "MCP write failed"));

  // Contract #3 on lend almost always means insufficient token balance.
  if (
    code === "simulation_failed" ||
    /simulation failed|hosterror|contract error|#3|error\(contract,\s*#3\)/i.test(raw)
  ) {
    if (tool === "vanna_deploy_to_blend") {
      const firstLine = raw.split(/\n/)[0]?.slice(0, 220) || raw.slice(0, 220);
      return (
        `Blend farm deploy simulation failed (this is **not** a margin collateral deposit).\n` +
        `${firstLine}\n\n` +
        `Common causes: not enough free balance of that asset in the margin account after ` +
        `the deposit leg, Blend pool constraints, or a zero deploy amount. No transaction was submitted.`
      );
    }
    if (tool === "vanna_lend") {
      // Try to extract balance from diagnostic: balance], data:9150000000 (7-dec SAC)
      const balMatch = raw.match(/balance\],\s*data:(\d+)/i);
      let balanceHint = "";
      if (balMatch) {
        const rawBal = balMatch[1];
        // Prefer 7-dec (BLUSDC/XLM SAC); fall back to 6-dec display.
        const as7 = Number(rawBal) / 1e7;
        const as6 = Number(rawBal) / 1e6;
        const human =
          Number.isFinite(as7) && as7 < 1e9
            ? as7.toLocaleString("en-US", { maximumFractionDigits: 7 })
            : as6.toLocaleString("en-US", { maximumFractionDigits: 6 });
        balanceHint = ` On-chain wallet balance seen in the sim: ~${human}.`;
      }
      return (
        `Earn supply failed simulation — usually **insufficient wallet balance** for that amount ` +
        `(or the token needs trustline/approval).${balanceHint}\n\n` +
        `No transaction was submitted. Check your wallet balance and try a smaller amount ` +
        `(earn uses XLM or BLUSDC/USDC-family SACs — not plain circle USDC on this testnet).`
      );
    }
    // Truncate huge event logs for other tools
    const firstLine = raw.split(/\n/)[0]?.slice(0, 280) || raw.slice(0, 280);
    return `Simulation failed: ${firstLine}`;
  }

  // Cap very long messages
  if (raw.length > 600) return raw.slice(0, 600) + "…";
  return raw;
}

/**
 * Why a risk rejection happened, when the tool makes the reason predictable.
 *
 * `vanna_deposit_and_borrow`'s pre-flight is `is_borrow_allowed(symbol,
 * borrow_amount, smart_account)` (vanna_core/contracts/account_manager.py) — and it
 * runs against the account's CURRENT on-chain state, before the deposit leg of the
 * same atomic call is credited. An account with little or no existing collateral is
 * therefore rejected no matter how large the deposit leg is, which reads as "the
 * copilot is broken" rather than "this combo needs collateral first". Splitting the
 * legs is the working route today.
 */
function rejectionGuidance(tool: string): string {
  if (tool === "vanna_deposit_and_borrow") {
    return (
      "\n\nThe borrow leg is checked against the collateral your account holds " +
      "*before* this transaction, so a combined deposit-and-borrow is refused while " +
      "your collateral is still too low — the deposit in the same call isn't counted " +
      "yet. Deposit the collateral first, then borrow against it as a second step."
    );
  }
  return "";
}

function traceOf(tool: string, build: Record<string, unknown>, xdr?: string | null) {
  return {
    tool,
    simulation_success: build.simulation_success === true || build.simulation_success === "true",
    auto_sign: build.auto_sign != null ? String(build.auto_sign) : null,
    auto_sign_error: build.auto_sign_error != null ? String(build.auto_sign_error) : null,
    has_unsigned_xdr: !!(xdr || pickXdr(build)),
  };
}

/**
 * Build via MCP write tool. Prefer MCP's own auto_sign attempt (many write tools
 * already try Sign Service and return auto_sign / auto_sign_error).
 *
 * Only call vanna_sign_and_submit if XDR exists and MCP has not already reported
 * auto_sign outcome.
 */
export async function executeMcpWrite(
  mcp: MCPClient,
  step: WriteStep,
  ctx: AccountCtx & { userId: string },
): Promise<McpWriteResult> {
  let build: Record<string, unknown>;
  try {
    build = await mcp.call(step.tool, step.args, ctx.userId);
  } catch (e) {
    return {
      tool: step.tool,
      label: step.label,
      build: {},
      status: "error",
      message: e instanceof Error ? e.message : String(e),
      mcp_trace: {
        tool: step.tool,
        has_unsigned_xdr: false,
        auto_sign: null,
        auto_sign_error: e instanceof Error ? e.message : String(e),
      },
    };
  }

  const xdr = pickXdr(build);
  const baseTrace = traceOf(step.tool, build, xdr);

  // Tool already finished on-chain (e.g. open_account with Sign Service)
  if (
    build.status === "signed_and_submitted" ||
    build.tx_hash ||
    build.submitted === true ||
    build.on_chain === true ||
    build.auto_sign === "submitted" ||
    build.auto_sign === "signed_and_submitted"
  ) {
    return {
      tool: step.tool,
      label: step.label,
      build,
      submitted: build,
      status: "signed_and_submitted",
      message:
        (build.summary as string) ||
        (build.message as string) ||
        `${step.label} completed on-chain.`,
      mcp_trace: baseTrace,
    };
  }

  if (build.error || build.status === "error") {
    const risk = isRiskRejection(build);
    const base = humanizeMcpWriteError(build, step.tool);
    return {
      tool: step.tool,
      label: step.label,
      build,
      // A risk-gate "no" is a decision, not a fault — see isRiskRejection.
      // Over-balance / sim-failed lend is "blocked" style rejection so the UI
      // doesn't look like a crash.
      status: risk || /insufficient wallet balance|simulation failed/i.test(base) ? "rejected" : "error",
      message: risk ? `${base}${rejectionGuidance(step.tool)}` : base,
      mcp_trace: baseTrace,
    };
  }

  // enable_auto_sign special shapes
  if (step.tool === "vanna_enable_auto_sign") {
    const st = String(build.status || "");
    if (st === "needs_confirmation") {
      return {
        tool: step.tool,
        label: step.label,
        build,
        status: "needs_auto_sign",
        message:
          (build.message as string) ||
          "Choose auto-sign limits: default $1000/tx & $1000/day, or set your own.",
        mcp_trace: baseTrace,
      };
    }
    if (st === "enabled" || build.enabled === true) {
      return {
        tool: step.tool,
        label: step.label,
        build,
        status: "done",
        message: (build.summary as string) || "Auto-sign is enabled.",
        mcp_trace: baseTrace,
      };
    }
  }

  if (!xdr) {
    return {
      tool: step.tool,
      label: step.label,
      build,
      status: "done",
      message: (build.summary as string) || (build.message as string) || `${step.label} done.`,
      mcp_trace: baseTrace,
    };
  }

  // MCP already tried auto-sign on the write tool itself
  const as = String(build.auto_sign || "").toLowerCase();
  const asErr = String(build.auto_sign_error || build.message || "");

  if (as === "unavailable" || as === "failed" || as === "error" || build.auto_sign_error) {
    // invalid_user_assertion / Invalid token audience = server M2M cannot prove end-user identity
    if (/invalid_user_assertion|invalid token audience|user assertion|re-authenticate/i.test(asErr + as)) {
      return {
        tool: step.tool,
        label: step.label,
        build,
        unsigned_xdr: xdr,
        status: "needs_wallet_sign",
        message:
          "Transaction built and simulated by MCP — it just needs a signature.\n\n" +
          "Auto-sign is unavailable because the Sign Service requires a user-scoped token " +
          "(a WorkOS user assertion). The copilot server holds only an M2M client token, which " +
          "proves the app's identity but not yours, so it cannot sign on your behalf. " +
          "Press approve to sign this exact transaction with your connected wallet.",
        mcp_trace: baseTrace,
      };
    }
    if (/no_active_session|disabled|not.?enabled|wallet_not_bound/i.test(asErr + as)) {
      return {
        tool: step.tool,
        label: step.label,
        build,
        unsigned_xdr: xdr,
        status: "needs_auto_sign",
        message:
          "MCP prepared the transaction. Auto-sign is not enabled for this wallet — enable it to submit without a wallet popup.",
        mcp_trace: baseTrace,
      };
    }
    // Other auto-sign failures: still have XDR → wallet sign
    return {
      tool: step.tool,
      label: step.label,
      build,
      unsigned_xdr: xdr,
      status: "needs_wallet_sign",
      message:
        (build.summary as string) ||
        `MCP prepared the transaction. Auto-sign unavailable (${asErr || as}). Sign with your wallet to submit.`,
      mcp_trace: baseTrace,
    };
  }

  // No auto_sign field — try explicit sign_and_submit once
  const wallet = looksG(ctx.trader) ? ctx.trader : ctx.userId;
  try {
    const submitted = await mcp.call(
      "vanna_sign_and_submit",
      {
        unsigned_xdr: xdr,
        user_id: ctx.userId || wallet,
        wallet_address: wallet,
      },
      ctx.userId,
    );

    const st = String(submitted.status || "");
    if (st === "signed_and_submitted" || submitted.tx_hash) {
      return {
        tool: step.tool,
        label: step.label,
        build,
        unsigned_xdr: xdr,
        submitted,
        status: "signed_and_submitted",
        message:
          (submitted.summary as string) ||
          `Signed & submitted${submitted.tx_hash ? ` · ${String(submitted.tx_hash).slice(0, 12)}…` : ""}`,
        mcp_trace: { ...baseTrace, auto_sign: "signed_and_submitted" },
      };
    }

    const reason = String(submitted.reason || submitted.detail || submitted.message || st);
    if (/invalid_user_assertion|invalid token audience|user assertion/i.test(reason)) {
      return {
        tool: step.tool,
        label: step.label,
        build,
        unsigned_xdr: xdr,
        submitted,
        status: "needs_wallet_sign",
        message:
          "Transaction built by MCP. The Sign Service needs a user-scoped token (not the server's " +
          "M2M key), so approve to sign this transaction with your connected wallet.",
        mcp_trace: { ...baseTrace, auto_sign_error: reason },
      };
    }
    if (/no_active_session|auto_sign.*disabled|wallet_not_bound|not.?enabled|no.?session/i.test(reason)) {
      return {
        tool: step.tool,
        label: step.label,
        build,
        unsigned_xdr: xdr,
        submitted,
        status: "needs_auto_sign",
        message:
          "MCP prepared the transaction. Enable auto-sign for this wallet to submit without a popup.",
        mcp_trace: baseTrace,
      };
    }

    return {
      tool: step.tool,
      label: step.label,
      build,
      unsigned_xdr: xdr,
      submitted,
      status: "needs_wallet_sign",
      message: `MCP prepared the transaction. Sign Service: ${reason}. You can sign with your wallet.`,
      mcp_trace: baseTrace,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      tool: step.tool,
      label: step.label,
      build,
      unsigned_xdr: xdr,
      status: "needs_wallet_sign",
      message: `MCP prepared the transaction. Auto-sign call failed (${msg}). Sign with your wallet to submit.`,
      mcp_trace: { ...baseTrace, auto_sign_error: msg },
    };
  }
}

export async function enableAutoSign(
  mcp: MCPClient,
  opts: {
    wallet: string;
    userId: string;
    useDefaultCaps?: boolean;
    maxPerTxUsd?: number | string;
    maxPerDayUsd?: number | string;
  },
): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = {
    wallet_address: opts.wallet,
    user_id: opts.userId || opts.wallet,
  };
  if (opts.useDefaultCaps) args.use_default_caps = true;
  if (opts.maxPerTxUsd != null) args.max_per_tx_usd = opts.maxPerTxUsd;
  if (opts.maxPerDayUsd != null) args.max_per_day_usd = opts.maxPerDayUsd;
  return mcp.call("vanna_enable_auto_sign", args, opts.userId);
}
