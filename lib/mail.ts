import nodemailer, { type Transporter } from "nodemailer";
import type { MailIdentity } from "./types";
import { listStoredIdentities } from "./identities-store";

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

export function isSmtpConfigured(): boolean {
  const ids = parseIdentities();
  if (ids.length === 0) return false;
  return ids.some((id) => resolveSmtp(id) !== null);
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

  const info = await transportFor(identity).sendMail({
    from: fromHeader,
    to: args.to,
    subject: finalSubject,
    text: finalBody,
    ...(pixel ? { html: bodyToTrackedHtml(finalBody, pixel) } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
  return { messageId: info.messageId };
}
