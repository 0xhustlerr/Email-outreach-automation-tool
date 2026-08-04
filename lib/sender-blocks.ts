// Per-account "paused for today" state, set when Gmail policy-blocks a sending
// account (see bounce-classify). Pure SQLite + an in-process memo: no network,
// so the queue worker, send-core and the API routes can all import it freely.
//
// EXPIRY IS A QUERY PREDICATE, NOT A JOB. A block is stored against the LOCAL
// calendar day it happened on; at midnight localDayKey() returns a new string,
// yesterday's rows stop matching, and every account resumes on its own.

import { db } from "./db";

export type BlockSource = "dsn" | "smtp" | "manual";

/** Wire shape sent to the UI and mirrored by the C# tray DTOs. */
export type SenderBlock = {
  /** Lowercased - every consumer keys off `email.toLowerCase()`. */
  sender: string;
  reason: string;
  /** The matched bounce line; shown only in a tooltip. */
  detail: string;
  blockedDay: string;
  /** ISO, STABLE for the life of the block - the tray dedups on it. */
  detectedAt: string;
  /** ISO of the next local midnight, when the block lifts itself. */
  until: string;
  source: BlockSource;
  statusCode: string;
  recipient: string;
};

type Row = {
  sender: string;
  day_key: string;
  blocked_at: string;
  reason: string;
  detail: string;
  status_code: string;
  source: string;
  gmail_id: string;
  recipient: string;
  resumed_at: string | null;
};

/**
 * The local calendar day as 'YYYY-MM-DD'.
 *
 * Deliberately a different convention from sentTodayBySender()'s
 * `new Date(y,m,d).toISOString()`: that one needs an ISO comparand for
 * send_log.date, this one only needs string equality for expiry. Reading
 * calendar fields means no epoch arithmetic and no midnight-boundary maths, so
 * a DST change is a non-issue - a spring-forward day still has one date.
 */
export function localDayKey(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** ISO of the next local midnight - when today's blocks lift. */
function nextLocalMidnight(d: Date = new Date()): string {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString();
}

function toBlock(r: Row): SenderBlock {
  return {
    sender: r.sender,
    reason: r.reason,
    detail: r.detail,
    blockedDay: r.day_key,
    detectedAt: r.blocked_at,
    until: nextLocalMidnight(),
    source: (r.source as BlockSource) ?? "dsn",
    statusCode: r.status_code,
    recipient: r.recipient,
  };
}

// eligiblePoolSenders() runs inside the claim predicate, i.e. up to CLAIM_SCAN
// (200) times per worker tick - it must not issue 200 queries. Memo keyed on
// the day so local midnight forces a miss even if nothing invalidates it.
type Memo = { day: string; at: number; set: Set<string> };
let memo: Memo | null = null;

function invalidate(): void {
  memo = null;
}

/** Accounts blocked right now (today, not manually resumed). Memoized ~2s. */
export function blockedSenderSet(maxAgeMs = 2000): Set<string> {
  const day = localDayKey();
  if (memo && memo.day === day && Date.now() - memo.at < maxAgeMs) {
    return memo.set;
  }
  let set = new Set<string>();
  try {
    const rows = db
      .prepare(
        `SELECT sender FROM sender_blocks
         WHERE day_key = ? AND resumed_at IS NULL`,
      )
      .all(day) as { sender: string }[];
    set = new Set(rows.map((r) => r.sender));
  } catch {
    // A read failure must never wedge sending - fail open.
    set = new Set<string>();
  }
  memo = { day, at: Date.now(), set };
  return set;
}

export function isSenderBlocked(email: string): boolean {
  return blockedSenderSet().has(email.trim().toLowerCase());
}

/** Active blocks with their reasons, for the status payload and the UI. */
export function listActiveBlocks(): SenderBlock[] {
  try {
    const rows = db
      .prepare(
        `SELECT * FROM sender_blocks
         WHERE day_key = ? AND resumed_at IS NULL
         ORDER BY blocked_at ASC`,
      )
      .all(localDayKey()) as Row[];
    return rows.map(toBlock);
  } catch {
    return [];
  }
}

/**
 * Record an automatic pause. Returns true only when it created the row, so the
 * caller can decide whether this is worth announcing.
 *
 * ON CONFLICT DO NOTHING is load-bearing twice over: it keeps the ORIGINAL
 * reason and timestamp (the tray dedups on detectedAt, so a moving timestamp
 * would re-toast every poll), and it cannot revive a block the user manually
 * resumed. A resumed account therefore stays resumed for the rest of the local
 * day no matter how many further bounces arrive - the only version that can't
 * flap into a resume -> send -> bounce -> pause loop.
 */
export function pauseSender(
  sender: string,
  info: {
    reason: string;
    detail?: string;
    statusCode?: string;
    source: Exclude<BlockSource, "manual">;
    gmailId?: string;
    recipient?: string;
  },
): boolean {
  const email = sender.trim().toLowerCase();
  if (!email) return false;
  try {
    const res = db
      .prepare(
        `INSERT INTO sender_blocks
           (sender, day_key, blocked_at, reason, detail, status_code, source,
            gmail_id, recipient)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sender, day_key) DO NOTHING`,
      )
      .run(
        email,
        localDayKey(),
        new Date().toISOString(),
        info.reason.slice(0, 200),
        (info.detail ?? "").slice(0, 300),
        info.statusCode ?? "",
        info.source,
        info.gmailId ?? "",
        info.recipient ?? "",
      );
    invalidate();
    return res.changes > 0;
  } catch {
    return false;
  }
}

/** Explicit user pause. Unlike the automatic path this clears a resume. */
export function pauseSenderManually(sender: string, reason = "Paused manually"): void {
  const email = sender.trim().toLowerCase();
  if (!email) return;
  try {
    db.prepare(
      // Every descriptive column is reset, not just the ones that change:
      // otherwise a manual pause landing on the same day as an earlier Gmail
      // block would keep that block's detail/status code and the badge tooltip
      // would claim a 5.7.1 bounce that never happened.
      `INSERT INTO sender_blocks
         (sender, day_key, blocked_at, reason, detail, status_code, source)
       VALUES (?, ?, ?, ?, '', '', 'manual')
       ON CONFLICT(sender, day_key) DO UPDATE SET
         resumed_at  = NULL,
         blocked_at  = excluded.blocked_at,
         reason      = excluded.reason,
         detail      = '',
         status_code = '',
         gmail_id    = '',
         recipient   = '',
         source      = 'manual'`,
    ).run(email, localDayKey(), new Date().toISOString(), reason.slice(0, 200));
    invalidate();
  } catch {
    // best effort
  }
}

/** Manual "resume now". Holds for the rest of the local day (see pauseSender). */
export function resumeSender(sender: string): boolean {
  const email = sender.trim().toLowerCase();
  if (!email) return false;
  try {
    const res = db
      .prepare(
        `UPDATE sender_blocks SET resumed_at = ?
         WHERE sender = ? AND day_key = ? AND resumed_at IS NULL`,
      )
      .run(new Date().toISOString(), email, localDayKey());
    invalidate();
    return res.changes > 0;
  } catch {
    return false;
  }
}

/** Blocks over the last `days` local days - "blocked 3 of the last 7" history. */
export function recentSenderBlocks(days = 14): SenderBlock[] {
  try {
    const since = localDayKey(new Date(Date.now() - days * 86_400_000));
    const rows = db
      .prepare(
        `SELECT * FROM sender_blocks WHERE day_key >= ?
         ORDER BY day_key DESC, blocked_at DESC`,
      )
      .all(since) as Row[];
    return rows.map(toBlock);
  } catch {
    return [];
  }
}

/** Drop all block/bounce state for an account (called when it is deleted). */
export function clearSenderBlocks(sender: string): void {
  const email = sender.trim().toLowerCase();
  if (!email) return;
  try {
    db.prepare(`DELETE FROM sender_blocks WHERE sender = ?`).run(email);
    db.prepare(`DELETE FROM bounce_events WHERE inbox = ? OR sender = ?`).run(
      email,
      email,
    );
    invalidate();
  } catch {
    // best effort
  }
}
