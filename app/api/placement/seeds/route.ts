import { NextResponse } from "next/server";
import { cachedAccessToken, clearGmailTokenCache, verifyGmailOAuth } from "@/lib/gmail";
import { getGmailClient } from "@/lib/identities-store";
import { listIdentities } from "@/lib/mail";
import { gmailProfileEmail } from "@/lib/placement/gmail-placement";
import { deleteSeedInbox, publicSeedInboxes, upsertSeedInbox } from "@/lib/placement/store";

// Extra Gmail inboxes that only receive placement tests. Tokens are verified
// on save and never returned.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Add or replace a seed inbox. Body: { email, refreshToken, clientId?, clientSecret? }. */
export async function PUT(req: Request) {
  let body: { email?: string; refreshToken?: string; clientId?: string; clientSecret?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }
  const email = (body.email ?? "").trim().toLowerCase();
  const refreshToken = (body.refreshToken ?? "").trim();
  const ownId = (body.clientId ?? "").trim();
  const ownSecret = (body.clientSecret ?? "").trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: "Enter the seed inbox's Gmail address." }, { status: 400 });
  }
  if (listIdentities().some((i) => i.email.toLowerCase() === email)) {
    return NextResponse.json(
      {
        ok: false,
        error: `${email} is already a Sender. Turn on its reply sync on the Accounts page and it becomes a seed automatically.`,
      },
      { status: 400 },
    );
  }
  if (!refreshToken) {
    return NextResponse.json({ ok: false, error: "Paste the inbox's refresh token." }, { status: 400 });
  }
  if ((ownId && !ownSecret) || (!ownId && ownSecret)) {
    return NextResponse.json(
      { ok: false, error: "Enter both the Client ID and the Client secret, or neither." },
      { status: 400 },
    );
  }
  const client = ownId && ownSecret ? { clientId: ownId, clientSecret: ownSecret } : getGmailClient();
  if (!client) {
    return NextResponse.json(
      {
        ok: false,
        error: "No Gmail OAuth client is saved yet. Enter this inbox's Client ID and secret.",
      },
      { status: 400 },
    );
  }

  const check = await verifyGmailOAuth(client.clientId, client.clientSecret, refreshToken);
  if (!check.ok) {
    return NextResponse.json(
      { ok: false, error: `Google rejected that token. ${check.error ?? ""}`.trim() },
      { status: 400 },
    );
  }
  // The token must really be for this address, or placements would be read
  // from the wrong mailbox and every test would look Missing.
  try {
    clearGmailTokenCache(email);
    const access = await cachedAccessToken(email, { ...client, refreshToken });
    const actual = await gmailProfileEmail(access);
    if (actual !== email) {
      clearGmailTokenCache(email);
      return NextResponse.json(
        { ok: false, error: `That token belongs to ${actual}, not ${email}.` },
        { status: 400 },
      );
    }
  } catch (e) {
    clearGmailTokenCache(email);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Could not read that inbox." },
      { status: 400 },
    );
  }

  upsertSeedInbox({ email, refreshToken, clientId: ownId, clientSecret: ownSecret });
  return NextResponse.json({ ok: true, seedInboxes: publicSeedInboxes() });
}

/** Remove a seed inbox. Body: { email }. */
export async function DELETE(req: Request) {
  let body: { email?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }
  const email = (body.email ?? "").trim().toLowerCase();
  if (!deleteSeedInbox(email)) {
    return NextResponse.json({ ok: false, error: "No such seed inbox." }, { status: 404 });
  }
  clearGmailTokenCache(email);
  return NextResponse.json({ ok: true, seedInboxes: publicSeedInboxes() });
}
