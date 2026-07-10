import { NextResponse } from "next/server";
import { recentSendsAfter } from "@/lib/recent-sends";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sends that went out since `after` (an event id). The UI polls this to pop a
// "just sent" toast for each new one. Does NOT mark user activity.
export async function GET(req: Request) {
  const after = Number(new URL(req.url).searchParams.get("after") ?? "0");
  const { latestId, events } = recentSendsAfter(Number.isFinite(after) ? after : 0);
  return NextResponse.json({ ok: true, latestId, events });
}
