import { NextResponse } from "next/server";
import {
  ackReplyNotifications,
  getReplySyncSnapshot,
  runReplySyncNow,
} from "@/lib/reply-sync-loop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reply detection is owned by the background loop armed in instrumentation.ts.
// This route no longer runs a sync per request - it reads the loop's cached
// result, so N polling clients cost N cheap reads instead of N concurrent
// full-inbox Gmail scans racing each other's sheet writes.

export async function GET() {
  return NextResponse.json({ ok: true, ...getReplySyncSnapshot() });
}

export async function POST(req: Request) {
  let body: { force?: boolean; ack?: string[] } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // Empty body is fine - treated as a plain read.
  }

  try {
    if (Array.isArray(body.ack) && body.ack.length > 0) {
      ackReplyNotifications(body.ack.filter((k) => typeof k === "string"));
    }

    // force = the user pressed Refresh and is watching a spinner. Everything
    // else reads the cache; runReplySyncNow collapses onto the in-flight cycle
    // when the loop happens to be mid-scan, so this can't stack up scans.
    const snapshot = body.force
      ? await runReplySyncNow()
      : getReplySyncSnapshot();

    if (snapshot.lastError && snapshot.replies.length === 0) {
      return NextResponse.json(
        { ok: false, error: snapshot.lastError, ...snapshot },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, ...snapshot });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Reply sync failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
