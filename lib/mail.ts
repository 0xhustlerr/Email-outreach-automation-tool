import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import type { MailIdentity, MailTransport, SenderTransport } from "./types";
import { listStoredIdentities, setLastTransport } from "./identities-store";
import { getAccessToken, parseGmailAccounts } from "./gmail";

export type { MailIdentity };

// Server-side identity carries optional SMTP credentials per account.
// Clients only ever see the `MailIdentity` shape (name + email).
type MailIdentityFull = MailIdentity & {
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
};

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "true" || v === "1" || v.toLowerCase() === "yes";
}

function parseEnvIdentities(): MailIdentityFull[] {
  const raw = process.env.MAIL_IDENTITIES?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as MailIdentityFull[];
      return parsed
        .filter((i) => i && typeof i.email === "string")
        .map((i) => ({
          name: i.name ?? i.email,
          email: i.email,
          smtpHost: i.smtpHost,
          smtpPort: i.smtpPort,
          smtpSecure: i.smtpSecure,
          smtpUser: i.smtpUser,
          smtpPass: i.smtpPass,
        }));
    } catch {
      // fall through to the SMTP_USER default below
    }
  }
  const user = process.env.SMTP_USER;
  return user ? [{ name: user, email: user }] : [];
}

// Identities available for sending come from the database. The env var
// MAIL_IDENTITIES is imported into the DB once on first run (see
// seedIdentitiesFromEnvOnce), after which the DB is the single source of truth
// so accounts can be added and removed from the Accounts UI. A live env parse is
// kept only as a safety net if the DB has no identities at all.
function parseIdentities(): MailIdentityFull[] {
  const stored = listStoredIdentities();
  if (stored.length > 0) {
    return stored.map((s) => ({
      name: s.name,
      email: s.email,
      smtpHost: s.smtpHost,
      smtpPort: s.smtpPort,
      smtpSecure: s.smtpSecure,
      smtpUser: s.smtpUser,
      smtpPass: s.smtpPass,
    }));
  }
  return parseEnvIdentities();
}

/** Drop cached SMTP transports so a re-added / removed account is re-resolved. */
export function clearTransportCache(): void {
  for (const t of transportCache.values()) {
    try {
      t.close();
    } catch {
      // ignore
    }
  }
  transportCache.clear();
}

/** Opens an SMTP connection and authenticates, to validate an account's app
 *  password before it is saved. Defaults to Gmail. */
export async function verifyIdentity(entry: {
  email: string;
  smtpUser?: string;
  smtpPass: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const host = entry.smtpHost?.trim() || "smtp.gmail.com";
  const port = entry.smtpPort ?? 465;
  const secure = entry.smtpSecure ?? port === 465;
  const user = (entry.smtpUser ?? entry.email).trim();
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass: entry.smtpPass.trim() },
  });
  try {
    await transport.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "SMTP verification failed" };
  } finally {
    transport.close();
  }
}

function resolveSmtp(id: MailIdentityFull): {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
} | null {
  const host = id.smtpHost ?? process.env.SMTP_HOST;
  const user = id.smtpUser ?? process.env.SMTP_USER;
  const pass = id.smtpPass ?? process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const port = id.smtpPort ?? Number(process.env.SMTP_PORT ?? 465);
  const secure = id.smtpSecure ?? bool(process.env.SMTP_SECURE, port === 465);
  return { host, port, secure, user, pass };
}

export function listIdentities(): MailIdentity[] {
  return parseIdentities().map(({ name, email }) => ({ name, email }));
}

/** Which transport `sendMail` would pick for this identity right now — the same
 *  test it applies below, kept here so callers never re-derive it from the
 *  underlying credentials and drift out of step with the real decision. */
function predictTransport(id: MailIdentityFull): MailTransport | "none" {
  if (!bool(process.env.MAIL_FORCE_SMTP, false) && hasGmailOAuth(id.email)) {
    return "gmail_api";
  }
  return resolveSmtp(id) !== null ? "smtp" : "none";
}

/** Per-account sending transport, keyed by lowercased email: what the next send
 *  would use, and what the last one actually used. Feeds the Accounts UI badge. */
export function listSenderTransports(): Record<string, SenderTransport> {
  const observed = new Map(
    listStoredIdentities().map((s) => [s.email.toLowerCase(), s.lastTransport]),
  );
  const out: Record<string, SenderTransport> = {};
  for (const id of parseIdentities()) {
    const key = id.email.toLowerCase();
    out[key] = {
      predicted: predictTransport(id),
      actual: observed.get(key) ?? null,
    };
  }
  return out;
}

/** True when at least one identity can send — via SMTP credentials or a Gmail
 *  OAuth token (the HTTPS API path). Gates the send routes. */
export function isSendConfigured(): boolean {
  const ids = parseIdentities();
  if (ids.length === 0) return false;
  return ids.some((id) => resolveSmtp(id) !== null || hasGmailOAuth(id.email));
}

function findIdentity(email: string): MailIdentityFull | null {
  const lower = email.toLowerCase();
  return (
    parseIdentities().find((i) => i.email.toLowerCase() === lower) ?? null
  );
}

// Cache transports by SMTP user+host so re-sending from the same identity
// reuses a warmed connection instead of handshaking every time.
const transportCache = new Map<string, Transporter>();
function transportFor(id: MailIdentityFull): Transporter {
  const cfg = resolveSmtp(id);
  if (!cfg) {
    throw new Error(
      `SMTP credentials missing for ${id.email}. Add smtpUser/smtpPass to the identity in MAIL_IDENTITIES, or set the top-level SMTP_USER/SMTP_PASS.`,
    );
  }
  const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
  let t = transportCache.get(key);
  if (!t) {
    t = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
    });
    transportCache.set(key, t);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Gmail API transport (HTTPS). Preferred over SMTP whenever the sender has an
// OAuth refresh token (the same one reply sync uses), because VPS hosts block
// outbound SMTP ports while leaving 443 open. Requires the token to have been
// consented with the gmail.send scope; a readonly-only token fails before the
// message is handed to Gmail and the send falls back to SMTP below.
// ---------------------------------------------------------------------------

function hasGmailOAuth(email: string): boolean {
  try {
    return email.toLowerCase() in parseGmailAccounts();
  } catch {
    return false;
  }
}

/** Failures that happen BEFORE Gmail could have accepted the message (token
 *  refresh, missing gmail.send scope) — retrying over SMTP cannot duplicate. */
class GmailAuthError extends Error {}

// Composes RFC 2822 MIME in memory, no network — one shared instance.
const mimeComposer = nodemailer.createTransport({
  streamTransport: true,
  buffer: true,
  newline: "unix",
});

async function sendViaGmailApi(
  senderEmail: string,
  mail: SendMailOptions,
): Promise<{ messageId: string }> {
  let access: string | null;
  try {
    access = await getAccessToken(senderEmail);
  } catch (e) {
    throw new GmailAuthError(
      e instanceof Error ? e.message : "Gmail token refresh failed",
    );
  }
  if (!access) throw new GmailAuthError(`No Gmail OAuth token for ${senderEmail}.`);

  const composed = await mimeComposer.sendMail(mail);
  const raw = (composed.message as Buffer).toString("base64url");

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; status?: string };
    };
    const detail = data.error?.message ?? `Gmail send failed (HTTP ${res.status}).`;
    // 401 / scope-related 403 = rejected before sending; eligible for SMTP
    // fallback. Everything else (rate limit, quota, policy) keeps Google's
    // wording so classifyBounceText in send-core sees the phrases it knows.
    if (
      res.status === 401 ||
      (res.status === 403 &&
        /insufficient|scope|permission/i.test(detail + (data.error?.status ?? "")))
    ) {
      throw new GmailAuthError(detail);
    }
    throw new Error(detail);
  }
  // Gmail preserves the Message-ID header nodemailer put in `raw`, so the id
  // returned here matches what recipients see — same contract as the SMTP
  // path, which threading and bounce-watch depend on.
  return { messageId: composed.messageId };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Minimal HTML twin of the plain-text body (kept simple for inbox placement),
// with a 1x1 open-tracking pixel appended.
function bodyToTrackedHtml(text: string, pixelUrl: string): string {
  const safe = escapeHtml(text);
  return (
    `<div style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">${safe}</div>` +
    `<img src="${pixelUrl}" width="1" height="1" alt="" style="border:0;height:1px;width:1px;overflow:hidden" />`
  );
}

export async function sendMail(args: {
  from: MailIdentity;
  to: string;
  /** Optional second recipient on the visible Cc line. */
  cc?: string;
  subject: string;
  body: string;
  /** RFC Message-ID of the message being replied to. */
  inReplyTo?: string;
  /** RFC References chain for threading. */
  references?: string;
  /** When set, send multipart text+HTML with this open-tracking pixel URL. */
  trackPixelUrl?: string;
}): Promise<{ messageId: string }> {
  const identity = findIdentity(args.from.email);
  if (!identity) {
    throw new Error(
      `Sender ${args.from.email} is not in MAIL_IDENTITIES.`,
    );
  }
  const displayName = args.from.name || identity.name;
  const fromHeader = displayName
    ? `"${displayName.replace(/"/g, '\\"')}" <${identity.email}>`
    : identity.email;

  // Resolve sender placeholders against the account that is ACTUALLY sending.
  // Done here (the single choke point for every send) so it is correct for
  // immediate sends, queued sends, and follow-ups even when the queue rotates
  // to a different account than the one chosen when the email was composed.
  const senderName = displayName || identity.name || identity.email;
  const resolveSender = (t: string) =>
    t
      .replace(/\{\{\s*sender_email\s*\}\}/gi, identity.email)
      .replace(/\{\{\s*sender\s*\}\}/gi, senderName);

  const headers: Record<string, string> = {};
  if (args.inReplyTo?.trim()) headers["In-Reply-To"] = args.inReplyTo.trim();
  if (args.references?.trim()) headers.References = args.references.trim();

  const finalSubject = resolveSender(args.subject);
  const finalBody = resolveSender(args.body);
  const pixel = args.trackPixelUrl?.trim();

  const cc = args.cc?.trim();
  const mail: SendMailOptions = {
    from: fromHeader,
    to: args.to,
    ...(cc ? { cc } : {}),
    subject: finalSubject,
    text: finalBody,
    ...(pixel ? { html: bodyToTrackedHtml(finalBody, pixel) } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };

  // Prefer the Gmail API (HTTPS) when this sender has an OAuth token — works
  // where outbound SMTP is blocked (VPS hosts). MAIL_FORCE_SMTP=1 opts out.
  // On an auth/scope failure the message never reached Gmail, so retrying
  // over SMTP cannot double-send; any other API error propagates as-is.
  if (!bool(process.env.MAIL_FORCE_SMTP, false) && hasGmailOAuth(identity.email)) {
    try {
      const sent = await sendViaGmailApi(identity.email, mail);
      setLastTransport(identity.email, "gmail_api");
      return sent;
    } catch (e) {
      if (!(e instanceof GmailAuthError) || !resolveSmtp(identity)) throw e;
      console.warn(
        `[mail] Gmail API auth failed for ${identity.email} — falling back to SMTP: ${e.message}`,
      );
    }
  }
  const info = await transportFor(identity).sendMail(mail);
  // Recorded only after the send succeeded, and after a fallback as well as a
  // plain SMTP send — a silent fallback is exactly what the badge exists to
  // show, so it must not look like an API send here.
  setLastTransport(identity.email, "smtp");
  return { messageId: info.messageId };
}
