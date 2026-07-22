// Single shared SQLite database for the app, stored at .data/app.db next to
// the other local state files. better-sqlite3 is synchronous, so callers can
// use it directly in API routes without await.
//
// The instance is cached on globalThis so Next.js dev-mode hot reloads reuse
// one connection instead of opening a new handle per reload.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_FILE = path.join(DATA_DIR, "app.db");

function openDb(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  // Wait (don't error) when another process holds the write lock. Next's 15
  // parallel build workers all initialize a fresh DB at once and serialize their
  // schema/seed writes through this, so the timeout is generous.
  db.pragma("busy_timeout = 60000");
  return db;
}

// Runs on every module load - including dev-mode hot reloads that reuse the
// cached connection - so schema added in code always reaches the file.
function ensureSchema(db: Database.Database): void {
  // The whole schema init (creates + column migrations) runs in ONE immediate
  // transaction so each process takes the write lock exactly once. Otherwise 15
  // parallel `next build` workers contend on every statement against a fresh DB
  // and hit SQLITE_BUSY / "duplicate column name".
  const init = db.transaction(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS send_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      date       TEXT NOT NULL,
      name       TEXT NOT NULL DEFAULT '',
      username   TEXT NOT NULL DEFAULT '',
      country    TEXT NOT NULL DEFAULT '',
      site       TEXT NOT NULL DEFAULT '',
      contact    TEXT NOT NULL DEFAULT '',
      link       TEXT NOT NULL DEFAULT '',
      sender     TEXT NOT NULL DEFAULT '',
      mail_sent  INTEGER NOT NULL DEFAULT 1,
      replied    INTEGER NOT NULL DEFAULT 0,
      replied_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_send_log_contact ON send_log (contact);

    CREATE TABLE IF NOT EXISTS reply_message_ids (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS avatars (
      key          TEXT PRIMARY KEY,  -- sha256(email), same key as the disk cache
      email        TEXT,              -- null when only the hash is known
      content_type TEXT NOT NULL DEFAULT 'image/jpeg',
      data         BLOB NOT NULL,
      fetched_at   TEXT NOT NULL
    );

    -- Contacts confirmed to have no public photo - the background prefetcher
    -- skips these for a while instead of retrying them every pass.
    CREATE TABLE IF NOT EXISTS avatar_negative (
      email        TEXT PRIMARY KEY,
      attempted_at TEXT NOT NULL
    );

    -- Email templates (subject/body with {{name}}/{{url}} placeholders).
    -- Seeded from the built-in defaults on first use; edited via the
    -- Manage Templates UI and applied to all future sends.
    CREATE TABLE IF NOT EXISTS templates (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      subject    TEXT NOT NULL,
      body       TEXT NOT NULL,
      sort       INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    -- Gmail thread conversations, cached so the replies panel opens
    -- instantly; refreshed stale-while-revalidate by the API route.
    CREATE TABLE IF NOT EXISTS conversations (
      thread_key TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,  -- JSON ConversationPayload
      updated_at TEXT NOT NULL
    );

    -- Discovered contact snapshots per profile: every email, phone number
    -- and telegram handle a scan surfaced, plus manually added URLs.
    -- Browsed via the Contacts modal in the main UI.
    CREATE TABLE IF NOT EXISTS contacts (
      key         TEXT PRIMARY KEY,           -- login (lowercased) or URL-derived
      login       TEXT NOT NULL DEFAULT '',
      profile_url TEXT NOT NULL DEFAULT '',
      name        TEXT NOT NULL DEFAULT '',
      country     TEXT NOT NULL DEFAULT '',
      emails      TEXT NOT NULL DEFAULT '[]', -- JSON string[]
      phones      TEXT NOT NULL DEFAULT '[]', -- JSON string[]
      telegrams   TEXT NOT NULL DEFAULT '[]', -- JSON string[]
      updated_at  TEXT NOT NULL
    );

    -- Outbound send queue. Emails are enqueued with fully-rendered subject/body
    -- and dripped out by the background worker (see lib/queue-worker.ts) to
    -- stay under provider spam thresholds.
    CREATE TABLE IF NOT EXISTS send_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      to_email    TEXT NOT NULL,
      from_email  TEXT NOT NULL DEFAULT '',    -- '' = auto-rotate at send time
      name        TEXT NOT NULL DEFAULT '',
      link        TEXT NOT NULL DEFAULT '',
      username    TEXT NOT NULL DEFAULT '',
      country     TEXT NOT NULL DEFAULT '',
      subject     TEXT NOT NULL,               -- already rendered
      body        TEXT NOT NULL,               -- already rendered
      status      TEXT NOT NULL DEFAULT 'queued', -- queued|sending|sent|failed|canceled
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT NOT NULL DEFAULT '',
      message_id  TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL,
      sent_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_send_queue_status ON send_queue (status, id);

    -- Single-row worker configuration (id is always 1).
    CREATE TABLE IF NOT EXISTS queue_settings (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      enabled        INTEGER NOT NULL DEFAULT 0,
      window_start   TEXT NOT NULL DEFAULT '09:00',
      window_end     TEXT NOT NULL DEFAULT '18:00',
      interval_sec   INTEGER NOT NULL DEFAULT 90,
      jitter_sec     INTEGER NOT NULL DEFAULT 40,
      daily_cap      INTEGER NOT NULL DEFAULT 80,
      rotate_senders INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO queue_settings (id) VALUES (1);

    -- Two-step send sequences (opener + optional threaded follow-up). Drives
    -- both lanes: 'send' (opener immediate, follow-up after a delay) and
    -- 'queue' (whole sequence dripped starting at a scheduled time). Also the
    -- source for the History status ticks. See lib/sequences-store.ts.
    CREATE TABLE IF NOT EXISTS sequences (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      lane          TEXT NOT NULL,               -- 'send' | 'queue'
      to_email      TEXT NOT NULL,
      from_email    TEXT NOT NULL DEFAULT '',
      name          TEXT NOT NULL DEFAULT '',
      link          TEXT NOT NULL DEFAULT '',
      username      TEXT NOT NULL DEFAULT '',
      country       TEXT NOT NULL DEFAULT '',
      -- opener (message 1)
      op_subject    TEXT NOT NULL,
      op_body       TEXT NOT NULL,
      op_status     TEXT NOT NULL DEFAULT 'pending', -- pending|sending|sent|failed
      op_message_id TEXT NOT NULL DEFAULT '',
      op_sent_at    TEXT,
      op_send_after TEXT,                         -- queue lane: opener eligible time
      -- follow-up (message 2); has_follow=0 means single send
      has_follow    INTEGER NOT NULL DEFAULT 0,
      fu_subject    TEXT NOT NULL DEFAULT '',
      fu_body       TEXT NOT NULL DEFAULT '',
      fu_delay_min  INTEGER NOT NULL DEFAULT 30,
      fu_status     TEXT NOT NULL DEFAULT 'waiting', -- waiting|scheduled|sending|sent|failed|skipped
      fu_message_id TEXT NOT NULL DEFAULT '',
      fu_sent_at    TEXT,
      fu_send_after TEXT,                         -- set once opener sends
      attempts      INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sequences_op ON sequences (op_status, op_send_after);
    CREATE INDEX IF NOT EXISTS idx_sequences_fu ON sequences (fu_status, fu_send_after);
    CREATE INDEX IF NOT EXISTS idx_sequences_to ON sequences (to_email);

    -- Gmail (or any SMTP) sending accounts added at runtime through the
    -- Accounts UI. Merged with the MAIL_IDENTITIES env var at send time, so a
    -- shipped production build can gain new senders without editing .env.local.
    -- smtp_pass is a Gmail App Password (stored as-is, same trust model as .env).
    CREATE TABLE IF NOT EXISTS mail_identities (
      email       TEXT PRIMARY KEY,   -- lowercased address
      name        TEXT NOT NULL DEFAULT '',
      smtp_host   TEXT NOT NULL DEFAULT 'smtp.gmail.com',
      smtp_port   INTEGER NOT NULL DEFAULT 465,
      smtp_secure INTEGER NOT NULL DEFAULT 1,
      smtp_user   TEXT NOT NULL DEFAULT '',
      smtp_pass   TEXT NOT NULL DEFAULT '',
      -- Per-account Gmail OAuth refresh token for READING replies (reply sync).
      -- Paired with the global client id/secret in app_meta. Empty = no sync.
      oauth_refresh_token TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL
    );

    -- Small key/value store for app-level flags (e.g. one-time migrations).
    CREATE TABLE IF NOT EXISTS app_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Template kind: 'opener' (message 1) or 'followup' (message 2). Drives the
  // Manage Templates tabs and the two dropdowns in the send window.
  const templateCols = (
    db.prepare(`PRAGMA table_info(templates)`).all() as { name: string }[]
  ).map((c) => c.name);
  if (!templateCols.includes("kind")) {
    db.exec(
      `ALTER TABLE templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'opener'`,
    );
    // One-time: the built-in long pitch templates are follow-ups (message 2).
    db.exec(
      `UPDATE templates SET kind = 'followup' WHERE id IN ('collaboration', 'remote-teamup')`,
    );
  }

  // Queue scheduled kickoff (ISO). Null = start as soon as enabled.
  const qsCols = (
    db.prepare(`PRAGMA table_info(queue_settings)`).all() as { name: string }[]
  ).map((c) => c.name);
  if (!qsCols.includes("start_at")) {
    db.exec(`ALTER TABLE queue_settings ADD COLUMN start_at TEXT`);
  }
  if (!qsCols.includes("fu_delay_min")) {
    db.exec(
      `ALTER TABLE queue_settings ADD COLUMN fu_delay_min INTEGER NOT NULL DEFAULT 30`,
    );
  }
  // Local-time sending: only send when it's a good hour in the RECIPIENT's
  // timezone (resolved on the sequence). Overrides the global window per contact.
  if (!qsCols.includes("local_time_send")) {
    db.exec(
      `ALTER TABLE queue_settings ADD COLUMN local_time_send INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!qsCols.includes("local_start")) {
    db.exec(`ALTER TABLE queue_settings ADD COLUMN local_start TEXT NOT NULL DEFAULT '07:00'`);
  }
  if (!qsCols.includes("local_end")) {
    db.exec(`ALTER TABLE queue_settings ADD COLUMN local_end TEXT NOT NULL DEFAULT '22:00'`);
  }
  // Sender allow-list (JSON array of sender emails). When non-empty, queue
  // openers are sent ONLY from these accounts (ignoring each item's original
  // sender). Empty = all configured identities are eligible.
  if (!qsCols.includes("sender_pool")) {
    db.exec(`ALTER TABLE queue_settings ADD COLUMN sender_pool TEXT NOT NULL DEFAULT '[]'`);
  }
  // Per-sender daily cap (distinct contacts per account per day). 0 = no
  // per-account limit; the global daily_cap still applies overall. Lets the
  // total cap be split across accounts so one address never over-sends.
  if (!qsCols.includes("per_sender_cap")) {
    db.exec(`ALTER TABLE queue_settings ADD COLUMN per_sender_cap INTEGER NOT NULL DEFAULT 0`);
  }
  // Follow-up strategy: the pitch (message 2) only sends after a reply. For
  // non-repliers, send ONE short link-free "bump" (rotated from bump templates)
  // this many days after the opener. bump_enabled toggles that nudge.
  if (!qsCols.includes("bump_enabled")) {
    db.exec(`ALTER TABLE queue_settings ADD COLUMN bump_enabled INTEGER NOT NULL DEFAULT 1`);
  }
  if (!qsCols.includes("bump_after_days")) {
    db.exec(`ALTER TABLE queue_settings ADD COLUMN bump_after_days INTEGER NOT NULL DEFAULT 2`);
  }
  // Per-account daily cap overrides (JSON object: lowercased email -> cap).
  // Accounts absent from the map fall back to per_sender_cap. Lets each
  // account get its own limit to match its warm-up status.
  if (!qsCols.includes("sender_caps")) {
    db.exec(`ALTER TABLE queue_settings ADD COLUMN sender_caps TEXT NOT NULL DEFAULT '{}'`);
  }

  // Columns added after the table first shipped - ALTER is idempotent-guarded
  // because SQLite has no "ADD COLUMN IF NOT EXISTS".
  const sendLogCols = (
    db.prepare(`PRAGMA table_info(send_log)`).all() as { name: string }[]
  ).map((c) => c.name);
  if (!sendLogCols.includes("active")) {
    db.exec(`ALTER TABLE send_log ADD COLUMN active INTEGER NOT NULL DEFAULT 0`);
  }
  // Sheet row number (2-based, matches _row from the Apps Script webhook).
  // Filled in by history reconciliation; null for sends not yet reconciled.
  if (!sendLogCols.includes("sheet_row")) {
    db.exec(`ALTER TABLE send_log ADD COLUMN sheet_row INTEGER`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_send_log_sheet_row ON send_log (sheet_row)`,
    );
  }
  // Soft-delete: hidden from the History view. Preserved across sheet
  // re-sync so deleted rows don't reappear.
  if (!sendLogCols.includes("deleted")) {
    db.exec(`ALTER TABLE send_log ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`);
  }
  // Standardized country (normalized from the raw free-form `country`), for
  // location-aware scheduling and clean reporting.
  if (!sendLogCols.includes("country_std")) {
    db.exec(`ALTER TABLE send_log ADD COLUMN country_std TEXT NOT NULL DEFAULT ''`);
  }
  // Open tracking: per-send pixel token, first "real" open time, and open count.
  if (!sendLogCols.includes("track_token")) {
    db.exec(`ALTER TABLE send_log ADD COLUMN track_token TEXT NOT NULL DEFAULT ''`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_send_log_track_token ON send_log (track_token)`,
    );
  }
  if (!sendLogCols.includes("opened_at")) {
    db.exec(`ALTER TABLE send_log ADD COLUMN opened_at TEXT`);
  }
  if (!sendLogCols.includes("open_count")) {
    db.exec(`ALTER TABLE send_log ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0`);
  }

  // Resolved location on queue sequences: standardized country + timezone for
  // local-time send scheduling. tz_source records which signal won (commit
  // offset / phone / location).
  const seqCols = (
    db.prepare(`PRAGMA table_info(sequences)`).all() as { name: string }[]
  ).map((c) => c.name);
  if (!seqCols.includes("country_std")) {
    db.exec(`ALTER TABLE sequences ADD COLUMN country_std TEXT NOT NULL DEFAULT ''`);
  }
  if (!seqCols.includes("timezone")) {
    db.exec(`ALTER TABLE sequences ADD COLUMN timezone TEXT NOT NULL DEFAULT ''`);
  }
  if (!seqCols.includes("tz_source")) {
    db.exec(`ALTER TABLE sequences ADD COLUMN tz_source TEXT NOT NULL DEFAULT ''`);
  }
  // When a non-replier's link-free bump was sent (ISO). Null = not bumped. The
  // sequence stays 'scheduled' so a later reply still triggers the pitch.
  if (!seqCols.includes("bump_sent_at")) {
    db.exec(`ALTER TABLE sequences ADD COLUMN bump_sent_at TEXT`);
  }
  // Per-profile URLs for the {{url_linkedin}} / {{url_github}} placeholders
  // ({{url}} / {{url_upwork}} keep using `link`). Stored so opener re-rotation
  // can re-render them after the item is queued.
  if (!seqCols.includes("link_linkedin")) {
    db.exec(`ALTER TABLE sequences ADD COLUMN link_linkedin TEXT NOT NULL DEFAULT ''`);
  }
  if (!seqCols.includes("link_github")) {
    db.exec(`ALTER TABLE sequences ADD COLUMN link_github TEXT NOT NULL DEFAULT ''`);
  }
  // Secondary recipient, CC'd on both steps. Set by the CSV import when two
  // discovered addresses score nearly the same and we can't tell which inbox
  // the contact actually reads. '' = no CC.
  if (!seqCols.includes("cc_email")) {
    db.exec(`ALTER TABLE sequences ADD COLUMN cc_email TEXT NOT NULL DEFAULT ''`);
  }

  const contactCols = (
    db.prepare(`PRAGMA table_info(contacts)`).all() as { name: string }[]
  ).map((c) => c.name);
  // direct = saved by hand via the ☆ button (no email sent); together with
  // "was emailed" this is one of the two doors into the Special list.
  if (!contactCols.includes("direct")) {
    db.exec(`ALTER TABLE contacts ADD COLUMN direct INTEGER NOT NULL DEFAULT 0`);
  }
  // Attach URL: the send modal's link field (at send time) or the ☆ popup's
  // input (direct saves) - the Upwork/website link tied to this profile.
  if (!contactCols.includes("attached_url")) {
    db.exec(
      `ALTER TABLE contacts ADD COLUMN attached_url TEXT NOT NULL DEFAULT ''`,
    );
  }

  // Per-account reply-sync refresh token, added after mail_identities first
  // shipped (guarded because SQLite has no "ADD COLUMN IF NOT EXISTS").
  const identCols = (
    db.prepare(`PRAGMA table_info(mail_identities)`).all() as { name: string }[]
  ).map((c) => c.name);
  if (!identCols.includes("oauth_refresh_token")) {
    db.exec(
      `ALTER TABLE mail_identities ADD COLUMN oauth_refresh_token TEXT NOT NULL DEFAULT ''`,
    );
  }
  });
  init.immediate();
}

const globalForDb = globalThis as unknown as { __appDb?: Database.Database };
export const db = globalForDb.__appDb ?? openDb();
globalForDb.__appDb = db;
ensureSchema(db);

/** One row of the local send log (mirrors the Google Sheets log). */
export type SendLogRow = {
  id: number;
  date: string;
  name: string;
  username: string;
  country: string;
  site: string;
  contact: string;
  link: string;
  sender: string;
  mail_sent: number;
  replied: number;
  replied_at: string | null;
  active: number;
  sheet_row: number | null;
  track_token: string;
  opened_at: string | null;
  open_count: number;
};

export function logSendToDb(entry: {
  date: string;
  name: string;
  username: string;
  country: string;
  site: string;
  contact: string;
  link: string;
  sender: string;
  mailSent: boolean;
  trackToken?: string;
}): void {
  try {
    db.prepare(
      `INSERT INTO send_log (date, name, username, country, site, contact, link, sender, mail_sent, track_token)
       VALUES (@date, @name, @username, @country, @site, @contact, @link, @sender, @mailSent, @trackToken)`,
    ).run({
      ...entry,
      mailSent: entry.mailSent ? 1 : 0,
      trackToken: entry.trackToken ?? "",
    });
  } catch {
    // Best-effort, same policy as the Sheets webhook - logging must never
    // break the send flow.
  }
}

/**
 * Fold a Worker open record into send_log. Filters pre-fetch "opens" (Apple
 * Mail Privacy / proxy warm-up) that fire within `minGapMs` of the send: those
 * bump the count but don't set `opened_at`. A real open is recognised when
 * EITHER a hit lands past the pre-fetch gap, OR the pixel is fetched two-plus
 * times spread `reopenGapMs` apart — the proxy warms the image up once on
 * delivery, so a later separated re-fetch is a genuine open even if both hits
 * fall inside the gap (the common case when a recipient opens within seconds).
 * Returns true when the row is (now) marked opened.
 */
export function recordOpenForToken(
  token: string,
  firstMs: number,
  lastMs: number,
  count: number,
  minGapMs = 12_000,
  reopenGapMs = 5_000,
): boolean {
  try {
    const row = db
      .prepare(`SELECT id, date, opened_at FROM send_log WHERE track_token = ?`)
      .get(token) as { id: number; date: string; opened_at: string | null } | undefined;
    if (!row) return false;

    const sendMs = Date.parse(row.date) || 0;
    let openedMs = 0;
    if (sendMs === 0) openedMs = firstMs; // no send time known - trust the pixel
    else if (firstMs - sendMs >= minGapMs) openedMs = firstMs;
    else if (lastMs - sendMs >= minGapMs) openedMs = lastMs;
    // Two+ hits separated by a real gap → the first was the proxy warm-up and a
    // later one is an actual open, even if both are inside the pre-fetch window.
    else if (count >= 2 && lastMs - firstMs >= reopenGapMs) openedMs = lastMs;

    if (openedMs > 0) {
      db.prepare(
        `UPDATE send_log SET opened_at = COALESCE(opened_at, ?), open_count = ? WHERE id = ?`,
      ).run(new Date(openedMs).toISOString(), count, row.id);
      return true;
    }
    db.prepare(`UPDATE send_log SET open_count = ? WHERE id = ?`).run(count, row.id);
    return false;
  } catch {
    return false;
  }
}

/**
 * Sends (with open-tracking status) to a given contact, oldest first. Used to
 * attach "seen" receipts to the OUTBOUND messages in a Gmail conversation by
 * matching each message to the nearest send by time.
 */
export function getContactSends(
  contact: string,
): { sentMs: number; openedAt: string | null; openCount: number }[] {
  try {
    const e = contact.trim().toLowerCase();
    if (!e) return [];
    const rows = db
      .prepare(
        `SELECT date, opened_at, open_count FROM send_log
         WHERE instr(lower(contact), ?) > 0
           AND mail_sent = 1
           AND COALESCE(deleted, 0) = 0
         ORDER BY date ASC`,
      )
      .all(e) as { date: string; opened_at: string | null; open_count: number }[];
    return rows.map((r) => ({
      sentMs: Date.parse(r.date) || 0,
      openedAt: r.opened_at,
      openCount: r.open_count ?? 0,
    }));
  } catch {
    return [];
  }
}

export function listSendLog(limit = 200): SendLogRow[] {
  return db
    .prepare(`SELECT * FROM send_log ORDER BY id DESC LIMIT ?`)
    .all(limit) as SendLogRow[];
}

export function markRepliedInDb(contact: string, repliedAt: string): void {
  try {
    db.prepare(
      `UPDATE send_log
       SET replied = 1, active = 1, replied_at = COALESCE(replied_at, ?)
       WHERE contact = ?`,
    ).run(repliedAt, contact);
  } catch {
    // Best-effort.
  }
}

/** Write-through cache: called by the avatar route whenever it fetches a new
 *  image, and by the one-time import of the existing disk cache. */
export function saveAvatarToDb(entry: {
  key: string;
  email: string | null;
  contentType: string;
  data: Buffer;
  fetchedAt: string;
}): void {
  try {
    db.prepare(
      `INSERT INTO avatars (key, email, content_type, data, fetched_at)
       VALUES (@key, @email, @contentType, @data, @fetchedAt)
       ON CONFLICT(key) DO UPDATE SET
         email        = COALESCE(excluded.email, avatars.email),
         content_type = excluded.content_type,
         data         = excluded.data,
         fetched_at   = excluded.fetched_at`,
    ).run(entry);
  } catch {
    // Best-effort.
  }
}

export function getAvatarFromDb(
  key: string,
): { data: Buffer; contentType: string } | null {
  try {
    const row = db
      .prepare(`SELECT data, content_type FROM avatars WHERE key = ?`)
      .get(key) as { data: Buffer; content_type: string } | undefined;
    return row ? { data: row.data, contentType: row.content_type } : null;
  } catch {
    return null;
  }
}
