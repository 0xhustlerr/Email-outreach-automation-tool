import { NextResponse } from "next/server";
import { sequenceTicksByEmail } from "@/lib/sequences-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-address two-step status for the History status ticks. Deliberately does
// NOT mark user activity — the History page polls this in the background.
export async function GET() {
  return NextResponse.json({ ok: true, ticks: sequenceTicksByEmail() });
}
