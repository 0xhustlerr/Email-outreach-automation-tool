import { NextResponse } from "next/server";
import {
  loadPersistedMessageIds,
  savePersistedMessageIds,
} from "@/lib/reply-sync-persist";
import { syncRepliesToSheet } from "@/lib/reply-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    let clientIds: Record<string, string> = {};
    try {
      const body = (await req.json()) as {
        lastMessageIds?: Record<string, string>;
      };
      if (body.lastMessageIds && typeof body.lastMessageIds === "object") {
        clientIds = body.lastMessageIds;
      }
    } catch {
      // Empty body is fine (tray sync uses server-persisted ids).
    }

    const persisted = loadPersistedMessageIds();
    const lastMessageIds = { ...persisted, ...clientIds };

    const result = await syncRepliesToSheet(lastMessageIds);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error ?? "Reply sync failed." },
        { status: 502 },
      );
    }

    if (result.messageIds && Object.keys(result.messageIds).length > 0) {
      savePersistedMessageIds(result.messageIds);
    }

    const { ok: _ok, ...rest } = result;
    return NextResponse.json({ ok: true, ...rest });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Reply sync failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
