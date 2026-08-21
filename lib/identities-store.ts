// Persistent SMTP sending identities added at runtime via the Accounts UI.
// These are merged with the MAIL_IDENTITIES env var in lib/mail.ts, so a shipped
// production build can gain new Gmail senders without editing .env.local.

import { db } from "./db";

export type StoredIdentity = {
  email: string;
  name: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  /** Per-account Gmail OAuth refresh token for reply sync ('' = not set). */
  oauthRefreshToken: string;
};

type Row = {
  email: string;
  name: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  smtp_user: string;
  smtp_pass: string;
  oauth_refresh_token: string;
};

function fromRow(r: Row): StoredIdentity {
  return {
    email: r.email,
    name: r.name,
    smtpHost: r.smtp_host,
    smtpPort: r.smtp_port,
    smtpSecure: r.smtp_secure !== 0,
    smtpUser: r.smtp_user,
    smtpPass: r.smtp_pass,
    oauthRefreshToken: r.oauth_refresh_token ?? "",
  };
}

export function listStoredIdentities(): StoredIdentity[] {
  try {
    const rows = db
      .prepare(`SELECT * FROM mail_identities ORDER BY created_at ASC`)
      .all() as Row[];
    return rows.map(fromRow);
  } catch {
    return [];
  }
}

/** One stored identity, CREDENTIALS INCLUDED — server-side only. Used by the
 *  Accounts "Reconnect" flow to renew an account's SMTP settings while keeping
 *  the app password already on file. */
export function getStoredIdentity(email: string): StoredIdentity | null {
  try {
    const row = db
      .prepare(`SELECT * FROM mail_identities WHERE email = ?`)
      .get(email.trim().toLowerCase()) as Row | undefined;
    return row ? fromRow(row) : null;
  } catch {
    return null;
  }
}

export function isStoredIdentity(email: string): boolean {
  try {
    return (
      db
        .prepare(`SELECT 1 FROM mail_identities WHERE email = ?`)
        .get(email.trim().toLowerCase()) !== undefined
    );
  } catch {
    return false;
  }
}

/** Add or update a stored identity. Defaults to Gmail SMTP when not supplied. */
export function upsertStoredIdentity(entry: {
  email: string;
  name?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass: string;
}): StoredIdentity {
  const email = entry.email.trim().toLowerCase();
  // Note: oauth_refresh_token is intentionally NOT written here, so re-adding /
  // editing a sending account preserves its reply-sync token.
  db.prepare(
    `INSERT INTO mail_identities
       (email, name, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, created_at)
     VALUES (@email, @name, @smtpHost, @smtpPort, @smtpSecure, @smtpUser, @smtpPass, @createdAt)
     ON CONFLICT(email) DO UPDATE SET
       name        = excluded.name,
       smtp_host   = excluded.smtp_host,
       smtp_port   = excluded.smtp_port,
       smtp_secure = excluded.smtp_secure,
       smtp_user   = excluded.smtp_user,
       smtp_pass   = excluded.smtp_pass`,
  ).run({
    email,
    name: (entry.name ?? "").trim() || email,
    smtpHost: entry.smtpHost?.trim() || "smtp.gmail.com",
    smtpPort: entry.smtpPort ?? 465,
    smtpSecure: (entry.smtpSecure ?? true) ? 1 : 0,
    smtpUser: (entry.smtpUser ?? email).trim(),
    smtpPass: entry.smtpPass.trim(),
    createdAt: new Date().toISOString(),
  });
  const row = db
    .prepare(`SELECT * FROM mail_identities WHERE email = ?`)
    .get(email) as Row;
  return fromRow(row);
}

export function deleteStoredIdentity(email: string): boolean {
  try {
    const info = db
      .prepare(`DELETE FROM mail_identities WHERE email = ?`)
      .run(email.trim().toLowerCase());
    return info.changes > 0;
  } catch {
    return false;
  }
}

/** Set (or clear, with '') the per-account reply-sync refresh token. */
export function setOAuthRefreshToken(email: string, token: string): boolean {
  try {
    const info = db
      .prepare(`UPDATE mail_identities SET oauth_refresh_token = ? WHERE email = ?`)
      .run(token.trim(), email.trim().toLowerCase());
    return info.changes > 0;
  } catch {
    return false;
  }
}

// --- app_meta helpers --------------------------------------------------------

function getMeta(key: string): string | null {
  try {
    const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setMeta(key: string, value: string): void {
  try {
    db.prepare(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  } catch {
    // ignore
  }
}

// --- global Gmail OAuth client (shared across accounts for reply sync) -------

export function getGmailClient(): { clientId: string; clientSecret: string } | null {
  const clientId = getMeta("gmail_client_id");
  const clientSecret = getMeta("gmail_client_secret");
  if (clientId && clientSecret) return { clientId, clientSecret };
  return null;
}

export function setGmailClient(clientId: string, clientSecret: string): void {
  setMeta("gmail_client_id", clientId.trim());
  setMeta("gmail_client_secret", clientSecret.trim());
}

// --- GitHub access token (per-install, for higher scan rate limits) ---------

/** UI-set GitHub token from the DB, falling back to the GITHUB_TOKEN env var. */
export function getGithubToken(): string | null {
  const fromDb = getMeta("github_token");
  if (fromDb && fromDb.trim()) return fromDb.trim();
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  return fromEnv ? fromEnv : null;
}

/** True when a token is configured in the DB (env fallback not counted). */
export function isGithubTokenSet(): boolean {
  const fromDb = getMeta("github_token");
  return !!(fromDb && fromDb.trim());
}

export function setGithubToken(token: string): void {
  setMeta("github_token", token.trim());
}

// --- one-time seed from the environment -------------------------------------
// Moves MAIL_IDENTITIES (and the SMTP_USER fallback) from .env into the database
// exactly once, so the accounts that shipped in the environment become editable
// and removable in the UI. After this runs, the database is the single source of
// truth for identities and the env var is ignored.

type EnvIdentity = {
  name?: string;
  email?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
};

export function seedIdentitiesFromEnvOnce(): void {
  if (getMeta("identities_seeded") === "1") return;

  const parsed: EnvIdentity[] = [];
  const raw = process.env.MAIL_IDENTITIES?.trim();
  if (raw) {
    try {
      const arr = JSON.parse(raw) as EnvIdentity[];
      for (const i of arr) if (i && typeof i.email === "string") parsed.push(i);
    } catch {
      // ignore malformed env
    }
  }
  if (parsed.length === 0 && process.env.SMTP_USER) {
    parsed.push({ email: process.env.SMTP_USER, name: process.env.SMTP_USER });
  }

  // Resolve each identity against the top-level SMTP_* fallbacks so the stored
  // record is self-contained (works even without the env afterwards).
  const envHost = process.env.SMTP_HOST?.trim();
  const envUser = process.env.SMTP_USER?.trim();
  const envPass = process.env.SMTP_PASS?.trim();
  const envPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;

  for (const i of parsed) {
    const email = (i.email ?? "").trim().toLowerCase();
    if (!email) continue;
    const smtpPass = (i.smtpPass ?? envPass ?? "").trim();
    if (!smtpPass) continue; // nothing usable to send with; skip
    upsertStoredIdentity({
      email,
      name: (i.name ?? email).trim(),
      smtpHost: i.smtpHost ?? envHost ?? "smtp.gmail.com",
      smtpPort: i.smtpPort ?? envPort ?? 465,
      smtpSecure: i.smtpSecure ?? true,
      smtpUser: (i.smtpUser ?? envUser ?? email).trim(),
      smtpPass,
    });
  }

  setMeta("identities_seeded", "1");
}

// --- history removal ---------------------------------------------------------
// When an account is removed, drop the data tied to it: hide its send history
// (soft-delete so a sheet re-sync won't resurrect it) and discard any pending
// queue items / sequences that would have sent from it.

export function deleteSenderData(email: string): {
  history: number;
  sequences: number;
} {
  const e = email.trim().toLowerCase();
  let history = 0;
  let sequences = 0;
  try {
    history = db
      .prepare(`UPDATE send_log SET deleted = 1 WHERE lower(sender) = ? AND deleted = 0`)
      .run(e).changes;
  } catch {
    // ignore
  }
  try {
    sequences = db
      .prepare(`DELETE FROM sequences WHERE lower(from_email) = ?`)
      .run(e).changes;
  } catch {
    // ignore
  }
  try {
    // Drop any Gmail block + bounce ledger for this account, so re-adding it
    // the same day doesn't resurrect yesterday's pause.
    db.prepare(`DELETE FROM sender_blocks WHERE sender = ?`).run(e);
    db.prepare(`DELETE FROM bounce_events WHERE inbox = ? OR sender = ?`).run(e, e);
  } catch {
    // ignore
  }
  return { history, sequences };
}

// Import env identities on first load so the app is immediately manageable.
// Skipped during `next build`: the seed isn't needed to compile, and 15 parallel
// build workers writing to a fresh DB at once would contend (SQLITE_BUSY). It
// runs normally the first time the server actually starts.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  seedIdentitiesFromEnvOnce();
}
