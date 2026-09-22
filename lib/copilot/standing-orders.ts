import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectAutomationGap } from "./conditional-guard";
import { resolveAsset } from "./registry/assets";
import { verifyApprovedPlan, type ApprovedPlan } from "./plan-approval";

/**
 * Standing orders the copilot can persist. Execution still requires a previously
 * approved frozen plan — this module never infers amounts or signs.
 */

export type StandingTrigger =
  | { kind: "health_factor"; op: "above" | "below"; value: string }
  | { kind: "price"; asset: string; op: "above" | "below"; usd: string };

export type StandingAction = { op: string; asset: string; amount: string };

export interface StandingOrder {
  id: string;
  subject: string;
  trader: string;
  smartAccount: string | null;
  trigger: StandingTrigger;
  action: StandingAction;
  expiry: number;
  approval: ApprovedPlan | null;
  status: "pending_approval" | "armed" | "fired" | "expired" | "cancelled";
  createdAt: number;
  lastEvaluatedAt: number | null;
}

const orders = new Map<string, StandingOrder>();
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;
let hydrated = false;

function persistPath(): string {
  return resolve(process.cwd(), ".local", "copilot-standing-orders", "orders.json");
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (process.env.NODE_ENV === "test") return;
  try {
    const raw = readFileSync(persistPath(), "utf8");
    const rows = JSON.parse(raw) as StandingOrder[];
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (row && typeof row.id === "string") orders.set(row.id, row);
    }
  } catch { /* first run or empty store */ }
}

function persist(): void {
  if (process.env.NODE_ENV === "test") return;
  const directory = resolve(process.cwd(), ".local", "copilot-standing-orders");
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(persistPath(), `${JSON.stringify([...orders.values()])}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.warn("[copilot] standing order persist failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const HEALTH_TRIGGER =
  /\b(?:health(?:\s+factor)?|hf)\b[^.?!]{0,40}\b(above|below|under|over|drops?|falls?|rises?|hits?|reaches?)\b[^.?!]{0,12}(\d+(?:\.\d+)?)/i;
const PRICE_TRIGGER =
  /\bwhen\b[^.?!]{0,40}\b(hits?|reaches?|crosses?|above|below|under|over)\b[^.?!]{0,12}\$?(\d+(?:\.\d+)?)/i;
const ACTION =
  /\b(repay|borrow|withdraw|lend|deposit)\s+(\d+(?:\.\d+)?)\s+([A-Za-z]{2,12})\b/i;

export function parseStandingOrder(message: string): { trigger: StandingTrigger; action: StandingAction } | null {
  const text = message.trim();
  if (!text) return null;
  const gap = detectAutomationGap(text, true);
  if (gap?.kind !== "standing_order" && gap?.kind !== "conditional") return null;
  const actionMatch = text.match(ACTION);
  if (!actionMatch) return null;
  const assetMatch = resolveAsset(actionMatch[3]);
  if (assetMatch.kind !== "asset") return null;
  const action: StandingAction = {
    op: actionMatch[1].toLowerCase(),
    asset: assetMatch.def.id,
    amount: actionMatch[2],
  };
  const health = text.match(HEALTH_TRIGGER);
  if (health) {
    const word = health[1].toLowerCase();
    const op: "above" | "below" = /above|over|rises|hits|reaches/.test(word) ? "above" : "below";
    return { trigger: { kind: "health_factor", op, value: health[2] }, action };
  }
  const price = text.match(PRICE_TRIGGER);
  if (price) {
    const named = resolveAsset(text);
    if (named.kind !== "asset") return null;
    const word = price[1].toLowerCase();
    const op: "above" | "below" = /above|over/.test(word) ? "above" : "below";
    return { trigger: { kind: "price", asset: named.def.id, op, usd: price[2] }, action };
  }
  return null;
}

export function createStandingOrder(input: {
  subject: string;
  trader: string;
  smartAccount: string | null;
  trigger: StandingTrigger;
  action: StandingAction;
  now?: number;
}): StandingOrder {
  hydrate();
  const now = input.now ?? Date.now();
  const order: StandingOrder = {
    id: randomUUID(),
    subject: input.subject,
    trader: input.trader,
    smartAccount: input.smartAccount,
    trigger: input.trigger,
    action: input.action,
    expiry: now + DEFAULT_TTL_MS,
    approval: null,
    status: "pending_approval",
    createdAt: now,
    lastEvaluatedAt: null,
  };
  orders.set(order.id, order);
  persist();
  return order;
}

export function armStandingOrder(id: string, plan: ApprovedPlan, now = Date.now()): StandingOrder {
  hydrate();
  const order = orders.get(id);
  if (!order) throw new Error("standing_order_missing");
  const check = verifyApprovedPlan(plan, now);
  if (!check.ok) throw new Error(check.message);
  order.approval = plan;
  order.status = "armed";
  persist();
  return order;
}

export function cancelStandingOrder(id: string, subject: string): StandingOrder | null {
  hydrate();
  const order = orders.get(id);
  if (!order || order.subject !== subject) return null;
  order.status = "cancelled";
  persist();
  return order;
}

export function listStandingOrders(subject: string): StandingOrder[] {
  hydrate();
  return [...orders.values()].filter((order) => order.subject === subject);
}

export function getStandingOrder(id: string): StandingOrder | undefined {
  hydrate();
  return orders.get(id);
}

function triggerMet(order: StandingOrder, live: { healthFactor: number | null; priceUsd: number | null }): boolean {
  if (order.trigger.kind === "health_factor") {
    if (live.healthFactor == null) return false;
    return order.trigger.op === "below" ? live.healthFactor < Number(order.trigger.value)
      : live.healthFactor > Number(order.trigger.value);
  }
  if (live.priceUsd == null) return false;
  return order.trigger.op === "below" ? live.priceUsd < Number(order.trigger.usd)
    : live.priceUsd > Number(order.trigger.usd);
}

/**
 * Evaluate armed orders. Returns the ones whose trigger is met AND that already hold a
 * verified approved plan. Callers execute those plans; this function does not.
 */
export function evaluateStandingOrders(input: {
  now?: number;
  liveFor: (order: StandingOrder) => { healthFactor: number | null; priceUsd: number | null };
}): StandingOrder[] {
  hydrate();
  const now = input.now ?? Date.now();
  const due: StandingOrder[] = [];
  for (const order of orders.values()) {
    if (order.status === "pending_approval" && now >= order.expiry) order.status = "expired";
    if (order.status !== "armed") continue;
    if (now >= order.expiry) {
      order.status = "expired";
      continue;
    }
    order.lastEvaluatedAt = now;
    if (!order.approval) continue;
    if (triggerMet(order, input.liveFor(order))) due.push(order);
  }
  persist();
  return due;
}

export function markStandingOrderFired(id: string): void {
  hydrate();
  const order = orders.get(id);
  if (order) {
    order.status = "fired";
    persist();
  }
}

export const STANDING_ORDER_OFFER =
  "I can store that as a standing order, but nothing will run until you approve a frozen plan for the action. " +
  "I will not watch or execute in the background without that mandate.";

/** Test-only. */
export function resetStandingOrders(): void {
  orders.clear();
}
