import { NextResponse } from "next/server";
import { fetchOpens, isTrackingEnabled } from "@/lib/tracking";
import { recordOpenForToken } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Poll the tracking Worker for this install's opens and fold them into send_log.
// Pre-fetch "opens" (fire within ~12s of send) bump the count but don't mark the
// row opened. Safe to call repeatedly — the Worker keeps opens, so a poll always
// catches up whatever happened while the app was closed.
async function sync() {
  if (!isTrackingEnabled()) {
    return NextResponse.json({ ok: true, enabled: false, records: 0, opened: 0 });
  }
  try {
    const opens = await fetchOpens();
    let opened = 0;
    for (const o of opens) {
      if (recordOpenForToken(o.token, o.first, o.last, o.count)) opened++;
    }
    return NextResponse.json({ ok: true, enabled: true, records: opens.length, opened });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Opens sync failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

export async function GET() {
  return sync();
}

export async function POST() {
  return sync();
}
