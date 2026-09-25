import type { FunctionDeclaration } from "../vertex-tools";
import { lpVenues, ASSET_IDS } from "../registry/assets";
import { CATALOG, catalogEntry, type ArgSpec } from "./catalog";
import { isRecord, PLAN_SIZINGS } from "./decision";
import { WORKFLOW_OPS } from "../workflow/types";
import { LIFECYCLE_WRITES } from "../workflow/lifecycle";
import type { ReadCapability } from "./types";

/**
 * The schema for ONE leg, shared by `plans[].legs[]` and `goal.actions[]`.
 *
 * These were two separate schemas, and the action one was strictly smaller — `op`, `asset`,
 * a bare decimal `amount`. So the model had no field in which to state "borrow 2x" or
 * "SOUSDC paired with XLM on Soroswap" as something the user had ASKED for, even though a
 * plan leg could express both. Those instructions could only survive as a free-form plan
 * the model chose to compose, and when it did not, the user's precise request came back as
 * unrelated ranked options.
 *
 * One schema, one parser (`parseLeg` in decision.ts): a capability a plan gains is a
 * capability a stated instruction gains, with nothing to keep in step by hand.
 */
function legSchema(extra?: { properties: Record<string, JsonSchema>; required: string[] }): JsonSchema {
  return {
    type: "object",
    properties: {
      op: { type: "string", enum: [...WORKFLOW_OPS] },
      asset: { type: "string", enum: [...ASSET_IDS] },
      assetOut: {
        type: "string", enum: [...ASSET_IDS],
        description: "REQUIRED whenever op is swap or add_liquidity: for swap, the asset received; for add_liquidity, the pool's other token. Either way it must differ from `asset`. A leg without it, on either op, is dropped. Never set it on any other op.",
      },
      venue: {
        type: "string", enum: [...lpVenues()],
        description: "swap or add_liquidity only, optional: the DEX the user named. Omit it and the protocol picks from the assets involved.",
      },
      sizing: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...PLAN_SIZINGS] },
          amount: { type: "string", description: "literal only: the user's exact decimal." },
          multiple: { type: "string", description: "leverage only: the multiplier the user stated, e.g. '2' for '2x'." },
          percent: { type: "string", description: "fraction only: the share as a percentage, e.g. '25' for '25%' or '50' for 'half'." },
          of: { type: "string", enum: ["idle", "position"], description: "fraction only: idle = the wallet's spendable balance; position = what the op spends (Earn position, posted collateral, debt)." },
          sourceQuote: { type: "string", description: "literal/fraction/leverage only: exact substring of the user message containing the amount, the share or the multiplier." },
          amountAsset: {
            type: "string", enum: ["asset", "assetOut"],
            description: "literal + op=swap only. Which of the leg's two assets `amount` is denominated in. Omit, or 'asset', for the ordinary case: amount is what the swap SPENDS. Set 'assetOut' when the user stated what they want to RECEIVE ('give me 15 SOUSDC', 'swap XLM to receive 961 AQUSDC', 'so it gives me 15 SOUSDC') — asset and assetOut stay exactly as they otherwise would; only this field, and the amount's meaning, change. Never on any other op.",
          },
        },
        required: ["kind"],
      },
      ...(extra?.properties ?? {}),
    },
    // A swap also requires assetOut. JSON Schema cannot make that conditional on
    // `op`, so it is stated in the field's own description and in the prompt.
    required: ["op", "asset", "sizing", ...(extra?.required ?? [])],
  };
}

const CONTROL_NAMES = new Set(["research_complete", "clarify", "blocked"]);
const READ_NAMES = new Set(CATALOG.map((entry) => entry.name));

type JsonSchema = NonNullable<FunctionDeclaration["parameters"]>;

function specSchema(spec: ArgSpec): JsonSchema {
  if (spec.type === "enum") {
    return { type: "string", enum: [...spec.values] };
  }
  if (spec.type === "decimal") {
    return {
      type: "string",
      description: "Positive decimal amount as a string (for example \"10.5\"). Never invent an amount.",
    };
  }
  return {
    type: "array",
    description: `One to ${spec.maxItems} canonical assets.`,
    items: { type: "string", enum: [...spec.values] },
  };
}

function readDecl(name: string): FunctionDeclaration {
  const entry = catalogEntry(name);
  if (!entry) throw new Error(`Unknown read capability: ${name}`);
  const keys = Object.keys(entry.modelArgs);
  const decl: FunctionDeclaration = {
    name: entry.name,
    description: `${entry.description} [cost:${entry.cost}] Identity is bound server-side; do not pass addresses.`,
  };
  if (keys.length === 0) return decl;
  const properties: Record<string, JsonSchema> = {};
  for (const [key, spec] of Object.entries(entry.modelArgs)) properties[key] = specSchema(spec);
  decl.parameters = { type: "object", properties, required: keys };
  return decl;
}

const CONTROL_DECLS: FunctionDeclaration[] = [
  {
    name: "research_complete",
    description:
      "Handoff research to the deterministic evaluator. Not permission to execute. " +
      "Cite live data with observation ids; conceptual answers may use empty evidenceIds.",
    parameters: {
      type: "object",
      properties: {
        intent: { type: "string", enum: ["answer", "strategy"] },
        relation: { type: "string", enum: ["new", "refine"] },
        objective: { type: "string", description: "User objective in one sentence." },
        constraints: { type: "array", items: { type: "string" } },
        borrowing: { type: "string", enum: ["unspecified", "allowed", "required", "forbidden"] },
        slippageAccepted: {
          type: "object",
          description: "Only when the user has said, in their own words, that they accept a loss or a poor outcome the server has put to them — \"i dont care if i lose\", \"do it anyway\", \"any price\", \"ignore the price impact\", \"i am ready to bear the loss\". accepted is true; sourceQuote is the exact substring of their message that says it. Not swap-specific: it lifts any guard that refuses a QUANTIFIED loss, including a borrow whose carry does not cover its cost. Never infer it from urgency, from naming an amount, or from them simply repeating the request — the server refuses such an outcome by default, and only the user's own words make it theirs to take.",
          properties: { accepted: { type: "boolean" }, sourceQuote: { type: "string" } },
          required: ["accepted", "sourceQuote"],
        },
        healthFactorFloor: {
          type: "object",
          description: "Only when the user stated a health-factor floor as a number. value is their exact decimal; sourceQuote is the exact substring of their message that contains it. Never invent a floor; 'avoid liquidation' is not one.",
          properties: { value: { type: "string" }, sourceQuote: { type: "string" } },
          required: ["value", "sourceQuote"],
        },
        planRelation: {
          type: "object",
          description: "Only when you return more than one plan. kind \"parts\" when the user asked for all of them together (one request covering several assets or venues), \"alternatives\" when they are different ways to do the same thing. sourceQuote is the exact substring of the user's message that decides it.",
          properties: { kind: { type: "string", enum: ["alternatives", "parts"] }, sourceQuote: { type: "string" } },
          required: ["kind", "sourceQuote"],
        },
        trigger: {
          type: "object",
          description: "Whether the user gated the action on a future event. kind \"none\" when the words only size the action (\"borrow until HF is 1.5\"). kind \"future_condition\" only when they asked to act later, when a price or a moment arrives; sourceQuote is the exact substring of their message that states that future event. Omit the field when there is no condition.",
          properties: {
            kind: { type: "string", enum: ["none", "future_condition"] },
            sourceQuote: { type: "string" },
          },
          required: ["kind"],
        },
        walletReserves: {
          type: "array",
          description: "Only when the user said to leave a stated amount of a token in the wallet, untouched by the plan. asset is the token; amount is their exact decimal; sourceQuote is the exact substring of their message that contains it. Never invent one.",
          items: {
            type: "object",
            properties: { asset: { type: "string" }, amount: { type: "string" }, sourceQuote: { type: "string" } },
            required: ["asset", "amount", "sourceQuote"],
          },
        },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              summary: { type: "string" },
              evidenceIds: { type: "array", items: { type: "string" } },
            },
            required: ["summary", "evidenceIds"],
          },
        },
        openQuestions: { type: "array", items: { type: "string" } },
        actions: {
          type: "array",
          description:
            "What the user literally instructed, leg by leg, in the order they said it. Same shape as a plan leg — " +
            "so state leverage as sizing.kind=leverage with the multiple ('borrow 2x' → multiple '2'), a pool pair " +
            "with assetOut, and the DEX with venue. Use this whenever the request is concrete, even when it has " +
            "several legs; it is what lets the server size exactly what was asked rather than proposing alternatives.",
          items: legSchema({
            properties: {
              sourceQuote: {
                type: "string",
                description: "Exact substring of the user's message that states this action.",
              },
            },
            required: ["sourceQuote"],
          }),
        },
        write: {
          type: "object",
          description:
            "A lifecycle write, not a plan: no asset, no amount. Opening a margin account is create_account. Quote the user's message. Never combine with goal.actions or plans.",
          properties: {
            op: { type: "string", enum: [...LIFECYCLE_WRITES] },
            sourceQuote: { type: "string" },
          },
          required: ["op", "sourceQuote"],
        },
        plans: {
          type: "array",
          description:
            "For intent=strategy: one to three strategy SHAPES as ordered legs. Sizing is a word, never a number — " +
            "all_idle (the asset's idle wallet balance), to_floor (the largest borrow — or withdrawal of posted collateral — at the user's health-factor floor), " +
            "previous_leg (the amount the previous leg produced, e.g. supply what was just borrowed), " +
            "literal (an amount the user typed, with sourceQuote), fraction (a share the user stated — '25%', 'half' — " +
            "of what the leg draws on: of=idle for the wallet balance, of=position for the Earn position, the posted collateral " +
            "or the debt; with sourceQuote). The server sizes, checks and ranks every plan.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short, e.g. 'Move idle XLM into Blend'." },
              rationale: { type: "string", description: "Why this shape serves the objective, citing observation ids." },
              evidenceIds: { type: "array", items: { type: "string" } },
              legs: { type: "array", items: legSchema() },
            },
            required: ["title", "rationale", "evidenceIds", "legs"],
          },
        },
      },
      required: ["objective", "constraints", "borrowing", "findings", "openQuestions"],
    },
  },
  {
    name: "clarify",
    description:
      "Ask ONE material question that no read can settle and that changes what would be executed.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
        missing: {
          type: "array",
          description: "What is still missing, in the user's order: one entry per action. op is the operation when they named one. asset is the token, or a bare family such as USDC. slots lists which of asset, venue and amount they did not give. sourceQuote is the exact substring of their message for that action. Do not list an action they already stated in full, and do not list options.",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: [...WORKFLOW_OPS] },
              asset: { type: "string", description: "A registry asset id, or a bare family the user said, such as USDC." },
              slots: { type: "array", items: { type: "string", enum: ["asset", "venue", "amount"] } },
              sourceQuote: { type: "string" },
            },
            required: ["slots"],
          },
        },
        actions: {
          type: "array",
          description: "Fully stated actions from the user's message that do not need clarification. Same shape as a plan leg with sourceQuote.",
          items: legSchema({
            properties: {
              sourceQuote: {
                type: "string",
                description: "Exact substring of the user's message that states this action.",
              },
            },
            required: ["sourceQuote"],
          }),
        },
        intent: {
          type: "string", enum: ["action", "strategy"],
          description: "action when the user stated what to do and only an input is missing; strategy when they asked you to choose what to do (a goal, not an instruction).",
        },
        trigger: {
          type: "object",
          description: "Carry the user's future-event gate even when another input is missing. kind future_condition means do not act now; sourceQuote is the exact substring that states the event. Omit when there is no future condition.",
          properties: {
            kind: { type: "string", enum: ["none", "future_condition"] },
            sourceQuote: { type: "string" },
          },
          required: ["kind"],
        },
      },
      required: ["question"],
    },
  },
  {
    name: "blocked",
    description: "Stop because of a specific limitation or missing evidence that cannot be read.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];

/**
 * Scope-filtered read declarations plus control functions. Writes are never declared.
 * Read decls come first so gathering stays the default move; controls are always present.
 */
export function investigationFunctionDeclarations(
  capabilities: readonly ReadCapability[],
): FunctionDeclaration[] {
  return [...capabilities.map((capability) => readDecl(capability.name)), ...CONTROL_DECLS];
}

function wrapComplete(args: Record<string, unknown>): Record<string, unknown> {
  const source = isRecord(args.goal) ? args.goal : args;
  const goal: Record<string, unknown> = {
    objective: source.objective,
    constraints: source.constraints,
    borrowing: source.borrowing,
  };
  if (source.intent !== undefined) goal.intent = source.intent;
  if (source.relation !== undefined) goal.relation = source.relation;
  if (source.actions !== undefined) goal.actions = source.actions;
  if (source.write !== undefined) goal.write = source.write;
  if (source.healthFactorFloor !== undefined) goal.healthFactorFloor = source.healthFactorFloor;
  if (source.walletReserves !== undefined) goal.walletReserves = source.walletReserves;
  if (source.planRelation !== undefined) goal.planRelation = source.planRelation;
  if (source.trigger !== undefined) goal.trigger = source.trigger;
  // Copied by name, like every field above it. A field the model answers and this does not
  // forward is a field that silently does not exist: 16 Sep, the card read "Understood as:
  // Swap 100 XLM for SOUSDC with explicit slippage acceptance" while the sizer refused the
  // swap for slippage, because the acceptance never left this function.
  if (source.slippageAccepted !== undefined) goal.slippageAccepted = source.slippageAccepted;
  const plans = args.plans ?? source.plans;
  return {
    kind: "research_complete",
    goal,
    findings: args.findings ?? source.findings,
    openQuestions: args.openQuestions ?? source.openQuestions,
    ...(plans !== undefined ? { plans } : {}),
  };
}

export interface ModelFunctionCall {
  name: string;
  args?: Record<string, unknown>;
}

/**
 * Native function calls → the same decision objects `parseDecision` already validates.
 * Parallel read calls become one inspect batch. Unknown names stay unparseable so the
 * runtime treats them as invalid_decision rather than forwarding them to MCP.
 */
export function decisionFromFunctionCalls(calls: readonly ModelFunctionCall[]): unknown {
  if (!calls.length) return { kind: "invalid_function" };
  const unknown = calls.find((call) => !READ_NAMES.has(call.name) && !CONTROL_NAMES.has(call.name));
  if (unknown) return { kind: "invalid_function", name: unknown.name };
  const reads = calls.filter((call) => READ_NAMES.has(call.name));
  if (reads.length) {
    return {
      kind: "inspect",
      reads: reads.map((call) => ({
        capability: call.name,
        args: isRecord(call.args) ? { ...call.args } : {},
      })),
    };
  }
  const control = calls.find((call) => CONTROL_NAMES.has(call.name));
  if (!control) return { kind: "invalid_function" };
  const args = isRecord(control.args) ? control.args : {};
  if (control.name === "clarify") return { kind: "clarify", question: args.question, ...(args.missing !== undefined ? { missing: args.missing } : {}), ...(args.actions !== undefined ? { actions: args.actions } : {}), ...(args.trigger !== undefined ? { trigger: args.trigger } : {}), ...(args.intent !== undefined ? { intent: args.intent } : {}) };
  if (control.name === "blocked") return { kind: "blocked", reason: args.reason };
  return wrapComplete(args);
}
