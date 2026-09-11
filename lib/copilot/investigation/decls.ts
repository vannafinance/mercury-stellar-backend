import type { FunctionDeclaration } from "../vertex-tools";
import { ASSET_IDS } from "../registry/assets";
import { CATALOG, catalogEntry, type ArgSpec } from "./catalog";
import { isRecord } from "./decision";
import type { ReadCapability } from "./types";

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
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["lend", "deposit_collateral", "borrow", "repay", "supply_blend"] },
              asset: { type: "string", enum: [...ASSET_IDS] },
              amount: { type: "string" },
              sourceQuote: { type: "string" },
            },
            required: ["op", "asset", "amount", "sourceQuote"],
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
      properties: { question: { type: "string" } },
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
  return {
    kind: "research_complete",
    goal,
    findings: args.findings ?? source.findings,
    openQuestions: args.openQuestions ?? source.openQuestions,
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
  if (control.name === "clarify") return { kind: "clarify", question: args.question };
  if (control.name === "blocked") return { kind: "blocked", reason: args.reason };
  return wrapComplete(args);
}
