import { NextResponse } from "next/server";
import { fetchGmailSignature, isGmailReauthError } from "@/lib/gmail";
import { isStoredIdentity } from "@/lib/identities-store";

// Pull a Sender's Signature from its Gmail settings. Body: { email }.
// Nothing is saved here: the signature comes back to the Accounts page, which
// puts it in the editor so it can be reviewed before Save (PUT /api/senders).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { email?: string } = {};
  try {
    body = (await req.json()) as { email?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !isStoredIdentity(email)) {
    return NextResponse.json({ ok: false, error: "That account was not found." }, { status: 404 });
  }

  try {
    const signature = await fetchGmailSignature(email);
    return NextResponse.json({ ok: true, signature });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Could not pull the Gmail signature.";
    return NextResponse.json(
      { ok: false, error, needsReauth: isGmailReauthError(error) },
      { status: 502 },
    );
  }
}
