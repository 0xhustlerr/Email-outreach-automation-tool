import { NextResponse } from "next/server";
import {
  clearTransportCache,
  isSendConfigured,
  listIdentities,
  verifyIdentity,
} from "@/lib/mail";
import {
  deleteSenderData,
  deleteStoredIdentity,
  getGmailClient,
  isGithubTokenSet,
  isStoredIdentity,
  listStoredIdentities,
  setGithubToken,
  setGmailClient,
  setOAuthRefreshToken,
  upsertStoredIdentity,
} from "@/lib/identities-store";
import {
  isGmailReplySyncConfigured,
  parseGmailAccounts,
  verifyGmailOAuth,
} from "@/lib/gmail";
import { verifyGithubToken } from "@/lib/github";
import {
  getTrackingBaseUrl,
  isTrackingEnabled,
  isTrackingUrlSet,
  setTrackingBaseUrl,
  setTrackingEnabled,
} from "@/lib/tracking";
import { isSheetsLoggerConfigured } from "@/lib/sheets";
import { listActiveBlocks } from "@/lib/sender-blocks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function snapshot() {
  const client = getGmailClient();
  const stored = listStoredIdentities();
  // Accounts whose reply sync is actually working, from EITHER the DB (per-account
  // refresh token) OR the environment (GMAIL_REFRESH_TOKENS on the dev machine),
  // so an env-configured account shows "on" instead of a misleading "off".
  const activeSync = parseGmailAccounts();
  const envClient = !!(
    process.env.GMAIL_CLIENT_ID?.trim() && process.env.GMAIL_CLIENT_SECRET?.trim()
  );
  return {
    smtpConfigured: isSendConfigured(),
    sheetsConfigured: isSheetsLoggerConfigured(),
    gmailReplySyncConfigured: isGmailReplySyncConfigured(),
    identities: listIdentities(),
    // Every identity is stored in the DB and therefore removable here.
    stored: stored.map((i) => i.email),
    // Reply-sync (reading incoming replies) state: whether the shared OAuth
    // client is set, and which accounts have working sync. Secrets are never
    // returned — only booleans.
    replySync: {
      clientConfigured: !!client || envClient,
      accounts: Object.fromEntries(
        stored.map((i) => [i.email, i.email.toLowerCase() in activeSync]),
      ) as Record<string, boolean>,
    },
    // Accounts Gmail policy-blocked; they resume on their own at `until` (the
    // next local midnight). An ARRAY, not a map, so the C# tray DTO stays a
    // plain List<T> — the tray reads this on the poll it already makes.
    senderBlocks: listActiveBlocks(),
    github: { tokenSet: isGithubTokenSet() },
    tracking: {
      urlSet: isTrackingUrlSet(),
      enabled: isTrackingEnabled(),
      url: getTrackingBaseUrl(),
    },
  };
}

export async function GET() {
  return NextResponse.json(snapshot());
}

// Add (or update) a sending account. Body: { name, email, appPassword, and
// optional advanced SMTP: smtpHost, smtpPort, smtpSecure, smtpUser }. The
// credentials are verified against the SMTP server before they are saved.
export async function POST(req: Request) {
  let body: {
    name?: string;
    email?: string;
    appPassword?: string;
    smtpHost?: string;
    smtpPort?: number;
    smtpSecure?: boolean;
    smtpUser?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const appPassword = (body.appPassword ?? "").trim();
  const name = (body.name ?? "").trim();
  const smtpHost = (body.smtpHost ?? "").trim() || "smtp.gmail.com";
  const smtpUser = (body.smtpUser ?? "").trim() || email;
  const smtpPort = Number.isFinite(body.smtpPort) ? Number(body.smtpPort) : 465;
  const smtpSecure = typeof body.smtpSecure === "boolean" ? body.smtpSecure : smtpPort === 465;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: "Enter a valid email address." }, { status: 400 });
  }
  if (appPassword.length < 8) {
    return NextResponse.json(
      { ok: false, error: "Enter the account's app password (16 characters for Gmail)." },
      { status: 400 },
    );
  }

  // Validate the credentials so a wrong app password fails here instead of
  // silently later at send time.
  const check = await verifyIdentity({
    email,
    smtpUser,
    smtpPass: appPassword,
    smtpHost,
    smtpPort,
    smtpSecure,
  });
  if (!check.ok) {
    // The SMTP server never answered (vs. answered and rejected the login) —
    // typical on VPS hosts, which block outbound 465/587 entirely. The
    // password can't be validated from here, but refusing to save would make
    // it impossible to add accounts on such machines at all. Save it and let
    // sending go over the Gmail API (HTTPS) once reply-sync OAuth is
    // connected for the account.
    const unreachable = /ETIMEDOUT|ETIMEOUT|ECONNREFUSED|ECONNRESET|ESOCKET|EDNS|ENETUNREACH|EHOSTUNREACH|greeting never received/i.test(
      check.error ?? "",
    );
    if (!unreachable) {
      const gmail = smtpHost.includes("gmail");
      return NextResponse.json(
        {
          ok: false,
          error: gmail
            ? "Could not sign in to Gmail with that app password. Make sure 2-Step Verification is on and you pasted a 16-character App Password (not your normal password). Details: " +
              (check.error ?? "authentication failed")
            : "Could not connect/sign in to the SMTP server. Details: " +
              (check.error ?? "authentication failed"),
        },
        { status: 400 },
      );
    }
    upsertStoredIdentity({ email, name: name || email, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass: appPassword });
    clearTransportCache();
    return NextResponse.json({
      ok: true,
      warning:
        "Saved, but the SMTP server could not be reached from this machine (outbound port blocked), so the app password was not verified. Connect reply-sync OAuth for this account — sending will then go over the Gmail API instead of SMTP.",
      ...snapshot(),
    });
  }

  upsertStoredIdentity({ email, name: name || email, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass: appPassword });
  clearTransportCache();

  return NextResponse.json({ ok: true, ...snapshot() });
}

// Reply-sync configuration. Two shapes:
//   { clientId, clientSecret }      -> save the shared OAuth client
//   { email, refreshToken }         -> set/clear an account's refresh token
export async function PUT(req: Request) {
  let body: {
    clientId?: string;
    clientSecret?: string;
    email?: string;
    refreshToken?: string;
    githubToken?: string;
    trackingUrl?: string;
    trackingEnabled?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  // Save (or clear) the open-tracking Worker URL.
  if (body.trackingUrl !== undefined) {
    const url = (body.trackingUrl ?? "").trim().replace(/\/+$/, "");
    if (!url) {
      setTrackingBaseUrl("");
      return NextResponse.json({ ok: true, cleared: true, ...snapshot() });
    }
    if (!/^https?:\/\//i.test(url)) {
      return NextResponse.json({ ok: false, error: "Enter a full URL starting with https://" }, { status: 400 });
    }
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (!res.ok || !data.ok) {
        return NextResponse.json(
          { ok: false, error: "That URL didn't respond as the tracking service (check /health)." },
          { status: 400 },
        );
      }
    } catch {
      return NextResponse.json(
        { ok: false, error: "Could not reach that URL. Make sure the Worker is deployed and public." },
        { status: 400 },
      );
    }
    setTrackingBaseUrl(url);
    return NextResponse.json({ ok: true, ...snapshot() });
  }

  // Toggle open tracking on/off (only meaningful when a URL is set).
  if (body.trackingEnabled !== undefined) {
    setTrackingEnabled(!!body.trackingEnabled);
    return NextResponse.json({ ok: true, ...snapshot() });
  }

  // Save (or clear) the GitHub access token for scans.
  if (body.githubToken !== undefined) {
    const token = (body.githubToken ?? "").trim();
    if (!token) {
      setGithubToken("");
      return NextResponse.json({ ok: true, cleared: true, ...snapshot() });
    }
    const check = await verifyGithubToken(token);
    if (!check.ok) {
      return NextResponse.json({ ok: false, error: check.error ?? "Invalid token." }, { status: 400 });
    }
    setGithubToken(token);
    return NextResponse.json({ ok: true, ...snapshot() });
  }

  // Save the shared OAuth client id/secret.
  if (body.clientId !== undefined || body.clientSecret !== undefined) {
    const clientId = (body.clientId ?? "").trim();
    const clientSecret = (body.clientSecret ?? "").trim();
    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { ok: false, error: "Enter both the OAuth Client ID and Client Secret." },
        { status: 400 },
      );
    }
    setGmailClient(clientId, clientSecret);
    return NextResponse.json({ ok: true, ...snapshot() });
  }

  // Set (or clear) an account's refresh token.
  if (body.email !== undefined) {
    const email = (body.email ?? "").trim().toLowerCase();
    const refreshToken = (body.refreshToken ?? "").trim();
    if (!isStoredIdentity(email)) {
      return NextResponse.json({ ok: false, error: "That account was not found." }, { status: 404 });
    }
    if (!refreshToken) {
      setOAuthRefreshToken(email, "");
      return NextResponse.json({ ok: true, cleared: true, ...snapshot() });
    }
    const client = getGmailClient();
    if (!client) {
      return NextResponse.json(
        { ok: false, error: "Set the OAuth Client ID and Secret first, then add the refresh token." },
        { status: 400 },
      );
    }
    const check = await verifyGmailOAuth(client.clientId, client.clientSecret, refreshToken);
    if (!check.ok) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "That refresh token didn't work with your Client ID/Secret. Re-generate it in the OAuth Playground for this exact account. Details: " +
            (check.error ?? "token exchange failed"),
        },
        { status: 400 },
      );
    }
    setOAuthRefreshToken(email, refreshToken);
    return NextResponse.json({ ok: true, ...snapshot() });
  }

  return NextResponse.json({ ok: false, error: "Nothing to update." }, { status: 400 });
}

// Remove an account and drop the data tied to it (send history is hidden, and
// pending queue items / sequences that would send from it are discarded).
// Body: { email }.
export async function DELETE(req: Request) {
  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ ok: false, error: "Missing email." }, { status: 400 });
  }

  const removedIdentity = deleteStoredIdentity(email);
  if (!removedIdentity) {
    return NextResponse.json({ ok: false, error: "That account was not found." }, { status: 404 });
  }
  const removed = deleteSenderData(email);
  clearTransportCache();

  return NextResponse.json({ ok: true, removed, ...snapshot() });
}
