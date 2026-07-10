import { NextResponse } from "next/server";
import { isSheetsLoggerConfigured } from "@/lib/sheets";
import {
  dbNeedsFirstReconcile,
  listHistoryFromDb,
  reconcileSheetToDb,
  softDeleteHistoryByEmails,
} from "@/lib/history-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Soft-delete history rows for the given addresses (hidden from view; not
// re-added on the next sheet sync).
export async function DELETE(req: Request) {
  let body: { emails?: string[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 },
    );
  }
  const emails = Array.isArray(body.emails) ? body.emails : [];
  if (emails.length === 0) {
    return NextResponse.json(
      { ok: false, error: "emails required." },
      { status: 400 },
    );
  }
  const removed = softDeleteHistoryByEmails(emails);
  return NextResponse.json({ ok: true, removed });
}

// Serves history from the local database (instant, offline-capable) and
// refreshes it from the Google Sheet in the background. Only the first-ever
// request blocks on the sheet, to attach _row numbers before the UI needs
// them for reply tracking.
export async function GET() {
  try {
    if (isSheetsLoggerConfigured() && dbNeedsFirstReconcile()) {
      await reconcileSheetToDb(true);
    } else {
      void reconcileSheetToDb();
    }

    // History is served from the local database (written on every send), so it
    // works fully without Google Sheets. A fresh install just returns an empty
    // list until the first email is sent.
    const rows = listHistoryFromDb();
    return NextResponse.json({ ok: true, rows });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to load history.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
