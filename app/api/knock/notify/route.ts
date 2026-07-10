import { NextResponse } from "next/server";
import { isKnockConfigured, notifyNewReply } from "@/lib/knock-server";
import type { SheetHistoryRow } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isKnockConfigured()) {
    return NextResponse.json(
      { error: "Knock is not configured." },
      { status: 503 },
    );
  }

  let body: {
    message?: string;
    rowId?: number;
    name?: string;
    contact?: string;
    sender?: string;
    site?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const rowId = Number(body.rowId);
  if (!rowId || rowId < 2) {
    return NextResponse.json({ error: "rowId is required." }, { status: 400 });
  }

  const row: SheetHistoryRow = {
    date: "",
    name: body.name ?? "",
    username: "",
    country: "",
    site: body.site ?? "",
    contact: body.contact ?? "",
    link: "",
    sender: body.sender ?? "",
    mailSent: "",
    _row: rowId,
  };

  try {
    await notifyNewReply(row, rowId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Knock notify failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
