import { NextResponse } from "next/server";
import { markUserActivity } from "@/lib/avatar-prefetch";
import {
  getThreadConversation,
  isGmailReplySyncConfigured,
  listPreviewFromConversation,
} from "@/lib/gmail";
import { attachOpenReceipts } from "@/lib/open-receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isGmailReplySyncConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Gmail reply sync is not configured." },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const sender = url.searchParams.get("sender")?.trim() ?? "";
  const contact = url.searchParams.get("contact")?.trim() ?? "";
  const after = url.searchParams.get("after")?.trim() ?? "";

  if (!sender || !contact) {
    return NextResponse.json(
      { ok: false, error: "sender and contact are required." },
      { status: 400 },
    );
  }

  try {
    const thread = await getThreadConversation(sender, contact, after);
    if (!thread) {
      return NextResponse.json({ ok: true, thread: null });
    }

    attachOpenReceipts(thread.messages, contact);

    return NextResponse.json({
      ok: true,
      thread,
      preview: listPreviewFromConversation(thread),
    });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "Failed to load conversation.";
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
