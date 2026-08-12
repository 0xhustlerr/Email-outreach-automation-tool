import { NextResponse } from "next/server";
import { clearTransportCache } from "@/lib/mail";
import {
  checkSendAccountsNow,
  getSenderHealth,
  recheckSendAccount,
} from "@/lib/sender-health";

// Live SMTP status for the connected sending accounts — the same check the
// server runs at startup, exposed so Accounts can re-run it on demand instead
// of the user having to restart the app to find out whether a connection is
// working again.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Last known status per account (empty until a check has run). */
export async function GET() {
  return NextResponse.json({ ok: true, results: getSenderHealth() });
}

// Re-verify now. Body: { email?, probe? }.
//   no email  -> re-check every connected account
//   email     -> re-check just that one
//   probe     -> when its own port can't be reached, also try the standard
//                alternate (465 <-> 587) and report one that works
export async function POST(req: Request) {
  let body: { email?: string; probe?: boolean } = {};
  try {
    body = (await req.json()) as { email?: string; probe?: boolean };
  } catch {
    // no body = re-check everything
  }

  // Cached transports hold sockets opened with the old settings, so drop them
  // first: otherwise a renewed account would test clean and still send through
  // the stale connection.
  clearTransportCache();

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email) {
    const results = await checkSendAccountsNow();
    return NextResponse.json({ ok: true, results });
  }

  const res = await recheckSendAccount(email, { probe: !!body.probe });
  if (!res) {
    return NextResponse.json(
      { ok: false, error: "That account was not found." },
      { status: 404 },
    );
  }

  return NextResponse.json({
    ok: true,
    results: [res.result],
    // Only set when the account's own port failed but another one connected and
    // signed in — the UI offers it as a one-click fix. No password: `working`
    // carries credentials and must not leave the server.
    suggestion: res.working
      ? {
          email: res.result.email,
          host: res.working.host,
          port: res.working.port,
          secure: res.working.secure,
        }
      : null,
  });
}
