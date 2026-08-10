/**
 * Workflows as data — Phase 3 of the consolidation plan.
 *
 * Op ordering used to live only as branches inside `expandPlanWrites`. Adding a
 * product surface meant editing that switch (and hoping `plan-approval` leg counts
 * stayed in sync). Here each op declares its ordered legs, whether they are
 * atomic, and why a split exists — protocol meaning next to the rule.
 *
 * Expansion still uses the shared sizers (`splitLeverageAmounts`,
 * `netOfOriginationFee`, `sameAsset`). This file owns *order and metadata*; math
 * stays in one place.
 *
 * Migration is a strangler: {@link WORKFLOWS} drives expand; a legacy expander
 * stays exported for the differential harness until every corpus row diffs empty.
 */

import { netOfOriginationFee } from "@/lib/borrow-fee";
import { sameAsset } from "../leverage-plan";
import { splitLeverageAmounts } from "../mcp-write";
import { toSlots } from "./intent";

/** One MCP-bound leg inside a workflow. */
export interface StepDef {
  /** Atomic op the executor will run. */
  op: string;
  /**
   * Where this leg's amount comes from when {@link WorkflowDef.sizing} is set.
   * `input` = the plan step's amount (pass-through / unlevered).
   */
  from?: "input" | "deposit" | "borrow" | "supply_net";
}

export interface WorkflowDef {
  op: string;
  steps: StepDef[];
  /** false ⇒ separate signatures / hops required. */
  atomic: boolean;
  /** Protocol reason for a non-atomic split — kept next to the rule. */
  splitWhy: string;
  sizing: "leverage" | "fraction" | null;
  requires: Array<"wallet" | "smart_account">;
  resumable: boolean;
}

/** Stable op ids that expand / mapOpToMcpStep understand. */
export type WorkflowOpId = keyof typeof WORKFLOWS;

/**
 * Declarative execution order per high-level op.
 *
 * Groups (cheapest → riskiest), matching the consolidation plan:
 *   account lifecycle → earn → farm → margin
 */
export const WORKFLOWS = {
  // ── Account lifecycle ───────────────────────────────────────────────────
  create_account: {
    op: "create_account",
    steps: [{ op: "create_account", from: "input" }],
    atomic: true,
    splitWhy: "Single open_account call.",
    sizing: null,
    requires: ["wallet"],
    resumable: false,
  },
  open_account: {
    op: "open_account",
    steps: [{ op: "create_account", from: "input" }],
    atomic: true,
    splitWhy: "Alias of create_account.",
    sizing: null,
    requires: ["wallet"],
    resumable: false,
  },
  settle_account: {
    op: "settle_account",
    steps: [{ op: "settle_account", from: "input" }],
    atomic: true,
    splitWhy: "Single settle call.",
    sizing: null,
    requires: ["smart_account"],
    resumable: false,
  },
  close_account: {
    op: "close_account",
    steps: [{ op: "close_account", from: "input" }],
    atomic: true,
    splitWhy: "Single close call.",
    sizing: null,
    requires: ["smart_account"],
    resumable: false,
  },

  // ── Earn ────────────────────────────────────────────────────────────────
  lend: {
    op: "lend",
    steps: [{ op: "lend", from: "input" }],
    atomic: true,
    splitWhy: "Single earn lend.",
    sizing: null,
    requires: ["wallet"],
    resumable: true,
  },
  supply: {
    op: "supply",
    steps: [{ op: "lend", from: "input" }],
    atomic: true,
    splitWhy: "Alias of lend on Earn.",
    sizing: null,
    requires: ["wallet"],
    resumable: true,
  },
  redeem: {
    op: "redeem",
    steps: [{ op: "redeem", from: "input" }],
    atomic: true,
    splitWhy: "Single earn redeem.",
    sizing: null,
    requires: ["wallet"],
    resumable: true,
  },

  // ── Farm / LP / swap ────────────────────────────────────────────────────
  swap: {
    op: "swap",
    steps: [{ op: "swap", from: "input" }],
    atomic: true,
    splitWhy: "Single swap call.",
    sizing: null,
    requires: ["wallet"],
    resumable: true,
  },
  add_liquidity: {
    op: "add_liquidity",
    steps: [{ op: "add_liquidity", from: "input" }],
    atomic: true,
    splitWhy: "Single LP add (fraction sizing applied by mapOpToMcpStep).",
    sizing: "fraction",
    requires: ["wallet"],
    resumable: true,
  },
  remove_liquidity: {
    op: "remove_liquidity",
    steps: [{ op: "remove_liquidity", from: "input" }],
    atomic: true,
    splitWhy: "Single LP remove (fraction sizing applied by mapOpToMcpStep).",
    sizing: "fraction",
    requires: ["wallet"],
    resumable: true,
  },
  /**
   * Unlevered Blend supply — one call. Levered paths use deploy_to_blend / supply
   * with L>1 and expand into deposit → borrow → supply (see expand below).
   */
  supply_to_blend: {
    op: "supply_to_blend",
    steps: [
      { op: "deposit_collateral", from: "deposit" },
      { op: "borrow", from: "borrow" },
      { op: "supply_to_blend", from: "supply_net" },
    ],
    atomic: false,
    splitWhy:
      "Levered farm must credit collateral before borrow, then supply free balance " +
      "(net of origination fee) into Blend — three signatures.",
    sizing: "leverage",
    requires: ["smart_account"],
    resumable: true,
  },
  deploy_to_blend: {
    op: "deploy_to_blend",
    steps: [
      { op: "deposit_collateral", from: "deposit" },
      { op: "borrow", from: "borrow" },
      { op: "supply_to_blend", from: "supply_net" },
    ],
    atomic: false,
    splitWhy:
      "Same as supply_to_blend @ L>1: deposit → borrow → supply. Unlevered deploy " +
      "collapses to a single supply_to_blend leg in expand.",
    sizing: "leverage",
    requires: ["smart_account"],
    resumable: true,
  },

  // ── Margin ──────────────────────────────────────────────────────────────
  deposit_collateral: {
    op: "deposit_collateral",
    steps: [{ op: "deposit_collateral", from: "input" }],
    atomic: true,
    splitWhy: "Single deposit.",
    sizing: null,
    requires: ["smart_account"],
    resumable: true,
  },
  withdraw_collateral: {
    op: "withdraw_collateral",
    steps: [{ op: "withdraw_collateral", from: "input" }],
    atomic: true,
    splitWhy: "Single withdraw.",
    sizing: null,
    requires: ["smart_account"],
    resumable: true,
  },
  borrow: {
    op: "borrow",
    steps: [{ op: "borrow", from: "input" }],
    atomic: true,
    splitWhy: "Single borrow.",
    sizing: null,
    requires: ["smart_account"],
    resumable: true,
  },
  repay: {
    op: "repay",
    steps: [{ op: "repay", from: "input" }],
    atomic: true,
    splitWhy: "Single repay.",
    sizing: null,
    requires: ["smart_account"],
    resumable: true,
  },
  deposit_and_borrow: {
    op: "deposit_and_borrow",
    steps: [
      { op: "deposit_collateral", from: "deposit" },
      { op: "borrow", from: "borrow" },
    ],
    atomic: false,
    splitWhy:
      "is_borrow_allowed runs against collateral before the deposit leg of the same " +
      "combined call is credited — so levered deposit+borrow must be two signatures. " +
      "Cross-asset sizing needs an oracle and stays whole until materializeLeverageWrites.",
    sizing: "leverage",
    requires: ["smart_account"],
    resumable: true,
  },
} as const satisfies Record<string, WorkflowDef>;

export function getWorkflow(op: string): WorkflowDef | null {
  const key = op in WORKFLOWS ? (op as keyof typeof WORKFLOWS) : null;
  return key ? WORKFLOWS[key] : null;
}

/** Expected on-chain legs for plan cards / signature counts. */
export function workflowLegCount(op: string, leverage: number | null): number {
  const wf = getWorkflow(op);
  if (!wf) return 1;
  const levered = leverage != null && leverage > 1;
  if (wf.sizing === "leverage" && levered) return wf.steps.length;
  // Unlevered deploy/supply_to_blend is one supply leg.
  if (
    (op === "deploy_to_blend" || op === "supply_to_blend") &&
    !levered
  ) {
    return 1;
  }
  if (op === "deposit_and_borrow" && (leverage == null || leverage > 1)) {
    return wf.steps.length;
  }
  return 1;
}

/** Minimal step shape expand needs (matches PlanStep write fields). */
export type WorkflowExpandStep = {
  kind?: string;
  op?: string | null;
  tool?: string | null;
  asset?: string | null;
  amount?: number | null;
  leverage?: number | null;
  borrow_asset?: string | null;
  args?: Record<string, unknown> | null;
  label?: string;
};

export type WorkflowExpandedLeg = {
  op: string;
  asset?: string | null;
  amount?: number | null;
  leverage?: number | null;
  borrow_asset?: string | null;
  token_in?: string | null;
  token_out?: string | null;
  label: string;
  multi_leg?: boolean;
  [slot: string]: unknown;
};

export type ExpandLabelFns = {
  write: (
    op: string,
    amount?: number | null,
    asset?: string | null,
    leverage?: number | null,
  ) => string;
  swap: (
    amount?: number | null,
    tokenIn?: string | null,
    tokenOut?: string | null,
  ) => string;
};

/**
 * Expand one plan step using {@link WORKFLOWS}.
 *
 * Behaviour matches the historical `expandPlanWrites` branches — the differential
 * harness asserts that. Unknown ops fall through as a single pass-through leg.
 */
export function expandStepViaWorkflow(
  step: WorkflowExpandStep,
  labels: ExpandLabelFns,
): WorkflowExpandedLeg[] {
  const op = String(step.op || step.tool || "");
  if (!op) return [];

  const slots = toSlots(step as Parameters<typeof toSlots>[0]);
  const {
    asset: slotAsset,
    amount: slotAmount,
    leverage: slotLeverage,
    borrow_asset: slotBorrow,
    ...restSlots
  } = slots;

  const asset =
    (typeof slotAsset === "string" ? slotAsset : null) ??
    step.asset ??
    (typeof step.args?.symbol === "string" ? step.args.symbol : null);
  const amount =
    (typeof slotAmount === "number" ? slotAmount : null) ??
    step.amount ??
    (step.args?.amount != null ? Number(step.args.amount) : null);
  const leverage =
    (typeof slotLeverage === "number" ? slotLeverage : null) ??
    (step.args?.leverage != null && Number.isFinite(Number(step.args.leverage))
      ? Number(step.args.leverage)
      : step.leverage != null && Number.isFinite(Number(step.leverage))
        ? Number(step.leverage)
        : null);
  const borrowAsset =
    (typeof slotBorrow === "string" ? slotBorrow : null) ??
    (typeof step.args?.borrow_asset === "string" ? step.args.borrow_asset : null) ??
    step.borrow_asset ??
    null;

  const carry = { ...restSlots };

  // ── Swap (token pair) ───────────────────────────────────────────────────
  if (op === "swap") {
    const tokenIn = (typeof slots.token_a === "string" && slots.token_a) || asset || "XLM";
    const tokenOut =
      (typeof slots.token_b === "string" && slots.token_b) || null;
    return [
      {
        ...carry,
        op: "swap",
        asset: tokenIn,
        amount,
        token_in: tokenIn,
        token_out: tokenOut,
        label: labels.swap(amount, tokenIn, tokenOut),
      },
    ];
  }

  const wf = getWorkflow(op);

  // ── Levered Blend: deposit → borrow → supply_net ────────────────────────
  if (
    (op === "deploy_to_blend" || op === "supply_to_blend") &&
    leverage != null &&
    leverage > 1
  ) {
    if (amount == null || !(amount > 0)) {
      return [
        {
          ...carry,
          op: "deploy_to_blend",
          asset,
          amount: null,
          leverage,
          label: labels.write("deploy_to_blend", null, asset, leverage) + " — need amount",
          multi_leg: true,
        },
      ];
    }
    const { deposit, borrow } = splitLeverageAmounts(amount, leverage, null);
    const supplyAmt = borrow > 0 ? netOfOriginationFee(borrow) : deposit;
    const steps = (wf ?? WORKFLOWS.deploy_to_blend).steps;
    return steps.map((sd) => {
      if (sd.from === "deposit") {
        return {
          ...carry,
          op: sd.op,
          asset,
          amount: deposit,
          label: labels.write(sd.op, deposit, asset),
        };
      }
      if (sd.from === "borrow") {
        return {
          ...carry,
          op: sd.op,
          asset,
          amount: borrow,
          label: labels.write(sd.op, borrow, asset),
        };
      }
      return {
        ...carry,
        op: sd.op,
        asset,
        amount: supplyAmt,
        leverage: null,
        label: labels.write(sd.op, supplyAmt, asset),
      };
    });
  }

  // ── Levered margin deposit+borrow ───────────────────────────────────────
  if (op === "deposit_and_borrow" && (leverage == null || leverage > 1)) {
    if (amount == null || !(amount > 0)) {
      return [
        {
          ...carry,
          op: "deposit_and_borrow",
          asset,
          amount: null,
          leverage: leverage ?? 2,
          borrow_asset: borrowAsset,
          label:
            labels.write("deposit_and_borrow", null, asset, leverage ?? 2) +
            " — need amount",
          multi_leg: true,
        },
      ];
    }
    const L = leverage ?? 2;
    // Cross-asset: keep whole until materializeLeverageWrites (needs oracle).
    if (borrowAsset && asset && !sameAsset(borrowAsset, asset)) {
      return [
        {
          ...carry,
          op: "deposit_and_borrow",
          asset,
          amount,
          leverage: L,
          borrow_asset: borrowAsset,
          label: labels.write("deposit_and_borrow", amount, asset, L),
          multi_leg: true,
        },
      ];
    }
    const { deposit, borrow } = splitLeverageAmounts(amount, L, null);
    const steps = (wf ?? WORKFLOWS.deposit_and_borrow).steps;
    return steps.map((sd) => {
      if (sd.from === "deposit") {
        return {
          ...carry,
          op: sd.op,
          asset,
          amount: deposit,
          label: labels.write(sd.op, deposit, asset),
        };
      }
      const loanAsset = borrowAsset || asset;
      return {
        ...carry,
        op: sd.op,
        asset: loanAsset,
        amount: borrow,
        label: labels.write(sd.op, borrow, loanAsset),
      };
    });
  }

  // ── Pass-through (atomic / unlevered / unknown) ─────────────────────────
  // Keep the plan's op spelling (supply vs lend, open_account vs create_account)
  // — historical expand did not rewrite aliases here.
  return [
    {
      ...carry,
      op,
      asset,
      amount,
      leverage,
      borrow_asset: borrowAsset,
      label: labels.write(op, amount, asset, leverage),
      multi_leg: false,
    },
  ];
}
