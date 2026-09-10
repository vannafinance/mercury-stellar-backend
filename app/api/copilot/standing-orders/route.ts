import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { isRecord } from "@/lib/copilot/investigation/decision";
import {
  armStandingOrder,
  cancelStandingOrder,
  getStandingOrder,
  listStandingOrders,
} from "@/lib/copilot/standing-orders";
import type { ApprovedPlan } from "@/lib/copilot/plan-approval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const loaded = await loadUserFromRequest(req);
  const subject = loaded.bound?.sub ?? "guest";
  return loaded.commit(NextResponse.json({ orders: listStandingOrders(subject) }, { headers: { "Cache-Control": "no-store" } }));
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ message: "Request origin was refused." }, { status: 403 });
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ message: "Invalid request." }, { status: 400 });
  }
  if (!isRecord(body) || typeof body.id !== "string") {
    return NextResponse.json({ message: "Send the standing-order id." }, { status: 400 });
  }
  const loaded = await loadUserFromRequest(req);
  const subject = loaded.bound?.sub ?? "guest";
  if (body.action === "cancel") {
    const order = cancelStandingOrder(body.id, subject);
    if (!order) return loaded.commit(NextResponse.json({ message: "Standing order not found." }, { status: 404 }));
    return loaded.commit(NextResponse.json({ order }));
  }
  if (body.action === "arm" && isRecord(body.approved_plan)) {
    const existing = getStandingOrder(body.id);
    if (!existing || existing.subject !== subject) {
      return loaded.commit(NextResponse.json({ message: "Standing order not found." }, { status: 404 }));
    }
    try {
      const order = armStandingOrder(body.id, body.approved_plan as unknown as ApprovedPlan);
      return loaded.commit(NextResponse.json({ order }));
    } catch (error) {
      return loaded.commit(NextResponse.json({
        message: error instanceof Error ? error.message : "This plan could not arm the standing order.",
      }, { status: 400 }));
    }
  }
  return loaded.commit(NextResponse.json({ message: "Unsupported standing-order action." }, { status: 400 }));
}
