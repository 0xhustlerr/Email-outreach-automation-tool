import { NextResponse } from "next/server";
import {
  clearTransportCache,
  isSendConfigured,
  isSmtpUnreachable,
  listIdentities,
  verifyIdentity,
} from "@/lib/mail";
import {
  deleteSenderData,
  deleteStoredIdentity,
  getGmailClient,
  getStoredIdentity,
  isGithubTokenSet,
  isStoredIdentity,
  listStoredIdentities,
  setGithubToken,
  setGmailClient,
  setInboxOAuthClient,
  setOAuthRefreshToken,
  upsertStoredIdentity,
} from "@/lib/identities-store";
import {
  forgetSenderHealth,
  getSenderHealth,
  recordSenderHealth,
} from "@/lib/sender-health";
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
import {
  forgetInboxAuth,
  getReplySyncSnapshot,
  recheckInboxAuthNow,
} from "@/lib/reply-sync-loop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function snapshot() {
  const client = getGmailClient();
  const stored = listStoredIdentities();
  // Accounts whose reply sync is actually working, from EITHER the DB (per-account
  // refresh token) OR the environment (GMAIL_REFRESH_TOKENS on the dev machine),
  // so an env-configured account shows "on" instead of a misleading "off".
  const activeSync = parseGmailAccounts();
  // Read the background loop's last result rather than exchanging tokens here:
  // this route is polled, and an OAuth round-trip per poll per account would be
  // both slow and rate-limited.
  const replySnapshot = getReplySyncSnapshot();
  const syncFailures = new Map(
    replySnapshot.inboxErrors.map((e) => [e.inbox.toLowerCase(), e]),
  );
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
    // Per-account SMTP settings, so Accounts can show what an account connects
    // through and pre-fill the Reconnect form. NEVER the password — only
    // whether one is on file.
    smtp: Object.fromEntries(
      stored.map((i) => [
        i.email,
        {
          host: i.smtpHost,
          port: i.smtpPort,
          secure: i.smtpSecure,
          user: i.smtpUser,
          hasPass: !!i.smtpPass,
        },
      ]),
    ),
    // Last known SMTP status per account, from the startup check and any manual
    // recheck. In-memory, so it is empty until the first check completes.
    health: getSenderHealth(),
    // Reply-sync (reading incoming replies) state: whether the shared OAuth
    // client is set, and which accounts have working sync. Secrets are never
    // returned — only booleans.
    replySync: {
      // Whether the GLOBAL fallback client exists (legacy shared-client setups
      // and the env). Per-inbox truth lives in accountClients below.
      clientConfigured: !!client || envClient,
      // Whether each inbox can verify a refresh token right now: its own
      // stored client, or the global fallback. Drives the Reply sync modal's
      // step gating per inbox.
      accountClients: Object.fromEntries(
        stored.map((i) => [
          i.email,
          !!(i.oauthClientId.trim() && i.oauthClientSecret.trim()) ||
            !!client ||
            envClient,
        ]),
      ) as Record<string, boolean>,
      // Having a refresh token on file is NOT the same as that token working.
      // A token minted by a since-replaced OAuth client still sits in the DB and
      // still shows up in parseGmailAccounts, but every refresh returns
      // unauthorized_client — so this used to report a green "sync on" for an
      // inbox that had not been read in weeks. Subtract whatever the last sync
      // cycle actually failed to read.
      accounts: Object.fromEntries(
        stored.map((i) => {
          const key = i.email.toLowerCase();
          return [i.email, key in activeSync && !syncFailures.has(key)];
        }),
      ) as Record<string, boolean>,
      // Why each failing inbox failed, so the page can say "reconnect this
      // account" instead of just going grey.
      accountErrors: Object.fromEntries(
        [...syncFailures].map(([email, e]) => [
          email,
          { error: e.error, needsReauth: e.needsReauth },
        ]),
      ),
      // Null until the first cycle completes. While null the account flags are
      // "token present", not "token verified" — nothing has been tried yet.
      lastSyncAt: replySnapshot.lastSyncAt,
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

// Add (or renew) a sending account. Body: { name, email, appPassword, and
// optional advanced SMTP: smtpHost, smtpPort, smtpSecure, smtpUser }. The
// credentials are verified against the SMTP server before they are saved.
//
// For an account that already exists this doubles as the Reconnect flow: the
// app password may be omitted to renew only the connection settings (port,
// username) against the password already on file, and any field left out keeps
// its stored value instead of silently reverting to the Gmail default. Moving
// the account to a DIFFERENT smtpHost is the one change that still requires the
// password in the body — see the note at `sameHost` below.
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
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: "Enter a valid email address." }, { status: 400 });
  }

  const existing = getStoredIdentity(email);
  const name = (body.name ?? "").trim() || existing?.name || email;
  const smtpHost = (body.smtpHost ?? "").trim() || existing?.smtpHost || "smtp.gmail.com";
  const smtpUser = (body.smtpUser ?? "").trim() || existing?.smtpUser || email;
  const smtpPort = Number.isFinite(body.smtpPort)
    ? Number(body.smtpPort)
    : (existing?.smtpPort ?? 465);
  // With no explicit flag: derive from the port when a port was actually given,
  // otherwise keep what is stored — a custom account on an implicit-TLS port
  // must not silently flip to plaintext just because it isn't 465.
  const smtpSecure =
    typeof body.smtpSecure === "boolean"
      ? body.smtpSecure
      : Number.isFinite(body.smtpPort)
        ? smtpPort === 465
        : (existing?.smtpSecure ?? smtpPort === 465);

  // The password on file is only reused for the account's OWN SMTP host. These
  // routes are unauthenticated, so without that check a drive-by POST could
  // point an existing account at any server and have us hand over the saved app
  // password during the verification login below.
  const sameHost =
    !!existing && existing.smtpHost.trim().toLowerCase() === smtpHost.toLowerCase();
  const appPassword =
    (body.appPassword ?? "").trim() || (sameHost ? (existing?.smtpPass ?? "") : "");

  if (appPassword.length < 8) {
    return NextResponse.json(
      {
        ok: false,
        error:
          existing && !sameHost
            ? `Enter the app password for ${smtpHost}. The one on file belongs to ${existing.smtpHost} and is not reused for a different server.`
            : "Enter the account's app password (16 characters for Gmail).",
      },
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
    // typical on VPS hosts, which block outbound 465/587 entirely, but also
    // what a transient network blip looks like. The password can't be
    // validated from here, and refusing to save would make it impossible to
    // add accounts on such machines at all, so save it with a warning.
    if (!isSmtpUnreachable(check.error ?? "")) {
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
    upsertStoredIdentity({ email, name, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass: appPassword });
    // Recorded only now that this config is the one on disk: a rejected login
    // above saves nothing, so publishing its failure would paint a still-working
    // account red (and leave a ghost entry for an account that was never added).
    recordSenderHealth({
      email,
      ok: false,
      target: `${smtpHost}:${smtpPort}`,
      error: check.error ?? "SMTP verification failed",
      unconfigured: false,
    });
    clearTransportCache();
    return NextResponse.json({
      ok: true,
      renewed: !!existing,
      warning: `Saved, but ${smtpHost}:${smtpPort} could not be reached from this machine, so the connection was not verified. If that outbound port is blocked here (common on VPS hosts and some office/ISP networks), sending from this account will fail until it is opened — try the other port (465 or 587) from Reconnect.`,
      ...snapshot(),
    });
  }

  upsertStoredIdentity({ email, name, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass: appPassword });
  // Verified against exactly what was just stored, so the Accounts list reflects
  // this check without waiting for the next restart or manual recheck.
  recordSenderHealth({
    email,
    ok: true,
    target: `${smtpHost}:${smtpPort}`,
    error: "",
    unconfigured: false,
  });
  clearTransportCache();

  return NextResponse.json({ ok: true, renewed: !!existing, ...snapshot() });
}

// Reply-sync configuration. Three shapes:
//   { email, clientId, clientSecret } -> save that inbox's own OAuth client
//   { clientId, clientSecret }        -> save the global fallback client
//   { email, refreshToken }           -> set/clear an inbox's refresh token
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

  // Save one inbox's own OAuth client (one Google Cloud project per inbox).
  // Scoped to that identity row, so connecting or re-connecting this inbox can
  // never invalidate the tokens of the others — which is exactly what saving a
  // new client into the shared slot used to do.
  if (
    body.email !== undefined &&
    (body.clientId !== undefined || body.clientSecret !== undefined)
  ) {
    const email = (body.email ?? "").trim().toLowerCase();
    const clientId = (body.clientId ?? "").trim();
    const clientSecret = (body.clientSecret ?? "").trim();
    if (!isStoredIdentity(email)) {
      return NextResponse.json({ ok: false, error: "That account was not found." }, { status: 404 });
    }
    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { ok: false, error: "Enter both the OAuth Client ID and Client Secret." },
        { status: 400 },
      );
    }
    setInboxOAuthClient(email, clientId, clientSecret);
    // Re-verify so a token already on file that was issued by a different
    // client shows up as broken NOW, with a message saying what to do.
    const replyAuth = await recheckInboxAuthNow();
    const mine = replyAuth.errors.find((e) => e.inbox === email && e.needsReauth);
    return NextResponse.json({
      ok: true,
      ...(mine
        ? {
            warning:
              `Saved — but the refresh token already on file for ${email} was issued by a different ` +
              `client (${mine.error}). Re-generate this inbox's token in the OAuth Playground with ` +
              `this client, then Save & verify below.`,
          }
        : {}),
      ...snapshot(),
    });
  }

  // Save the global fallback OAuth client id/secret (legacy shared-client
  // setups; the Accounts UI now writes per-inbox clients above).
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
    // A refresh token only works with the OAuth client that issued it, so
    // replacing the shared client silently kills reply sync for every inbox
    // whose token the OLD client minted. Verify each stored token against the
    // new client right now and name the casualties, instead of letting the
    // next sync cycle discover them as an unexplained "Reply sync broken".
    const replyAuth = await recheckInboxAuthNow();
    const broken = replyAuth.errors
      .filter((e) => e.needsReauth)
      .map((e) => e.inbox);
    return NextResponse.json({
      ok: true,
      ...(broken.length > 0
        ? {
            warning:
              `This client does not match the refresh token${broken.length === 1 ? "" : "s"} already saved for ` +
              `${broken.join(", ")}. Reply sync for ${broken.length === 1 ? "that inbox" : "those inboxes"} ` +
              `stays broken until each token is re-generated in the OAuth Playground with THIS client.`,
          }
        : {}),
      ...snapshot(),
    });
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
      forgetInboxAuth(email);
      return NextResponse.json({ ok: true, cleared: true, ...snapshot() });
    }
    // Verify with the client this inbox will actually sync through: its own
    // stored client when set, the global fallback otherwise.
    const stored = getStoredIdentity(email);
    const ownId = stored?.oauthClientId.trim();
    const ownSecret = stored?.oauthClientSecret.trim();
    const client =
      ownId && ownSecret
        ? { clientId: ownId, clientSecret: ownSecret }
        : getGmailClient();
    if (!client) {
      return NextResponse.json(
        { ok: false, error: "Set this inbox's OAuth Client ID and Secret first, then add the refresh token." },
        { status: 400 },
      );
    }
    const check = await verifyGmailOAuth(client.clientId, client.clientSecret, refreshToken);
    if (!check.ok) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "That refresh token didn't work with this inbox's Client ID/Secret. Re-generate it in the OAuth Playground for this exact account, using the same client saved above. Details: " +
            (check.error ?? "token exchange failed"),
        },
        { status: 400 },
      );
    }
    setOAuthRefreshToken(email, refreshToken);
    // The token just verified against the current client, so any recorded
    // failure for this inbox is stale — drop it now rather than leaving it
    // "broken" until the next sync cycle.
    forgetInboxAuth(email);
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
  forgetSenderHealth(email);
  clearTransportCache();
  forgetInboxAuth(email);

  return NextResponse.json({ ok: true, removed, ...snapshot() });
}
