// Persistence for the send queue and its worker settings. All queue reads and
// writes go through here; the worker (lib/queue-worker.ts) uses claimNext /
// markSent / markFailed, the API exposes the rest.

import { db } from "./db";

export type QueueStatus = "queued" | "sending" | "sent" | "failed" | "canceled";

export type QueueItem = {
  id: number;
  toEmail: string;
  fromEmail: string;
  name: string;
  link: string;
  username: string;
  country: string;
  subject: string;
  body: string;
  status: QueueStatus;
  attempts: number;
  lastError: string;
  messageId: string;
  createdAt: string;
  sentAt: string | null;
};

export type QueueSettings = {
  enabled: boolean;
  windowStart: string; // "HH:MM"
  windowEnd: string;
  intervalSec: number;
  jitterSec: number;
  dailyCap: number; // by distinct recipient address, not email count
  rotateSenders: boolean;
  startAt: string | null; // ISO — queue kickoff; null = start when enabled
  fuDelayMin: number; // default follow-up delay for queue-lane sequences
  localTimeSend: boolean; // send by the recipient's local time
  localStart: string; // recipient-local window "HH:MM"
  localEnd: string;
  senderPool: string[]; // if non-empty, openers send ONLY from these accounts
  // Legacy uniform per-sender cap. No longer enforced or shown — each account
  // carries its own cap in senderCaps. Kept so the existing column/row and old
  // clients keep working.
  perSenderCap: number;
  // Each account's daily cap (lowercased email -> distinct contacts per day).
  // No entry = that account is uncapped. A patch REPLACES the whole map.
  senderCaps: Record<string, number>;
  bumpEnabled: boolean; // send a link-free bump to non-repliers
  bumpAfterDays: number; // days after the opener to send the bump
};

type ItemRow = {
  id: number;
  to_email: string;
  from_email: string;
  name: string;
  link: string;
  username: string;
  country: string;
  subject: string;
  body: string;
  status: QueueStatus;
  attempts: number;
  last_error: string;
  message_id: string;
  created_at: string;
  sent_at: string | null;
};

function toItem(r: ItemRow): QueueItem {
  return {
    id: r.id,
    toEmail: r.to_email,
    fromEmail: r.from_email,
    name: r.name,
    link: r.link,
    username: r.username,
    country: r.country,
    subject: r.subject,
    body: r.body,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    messageId: r.message_id,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

export function enqueue(item: {
  toEmail: string;
  fromEmail?: string;
  name?: string;
  link?: string;
  username?: string;
  country?: string;
  subject: string;
  body: string;
}): QueueItem | { skipped: true; reason: string } {
  const to = item.toEmail.trim().toLowerCase();
  // Don't re-queue something already pending or already sent to.
  const dupPending = db
    .prepare(
      `SELECT 1 FROM send_queue WHERE to_email = ? AND status IN ('queued','sending') LIMIT 1`,
    )
    .get(to);
  if (dupPending) return { skipped: true, reason: "already queued" };
  const alreadySent = db
    .prepare(`SELECT 1 FROM send_log WHERE lower(contact) = ? LIMIT 1`)
    .get(to);
  if (alreadySent) return { skipped: true, reason: "already emailed" };

  const info = db
    .prepare(
      `INSERT INTO send_queue (to_email, from_email, name, link, username, country, subject, body, created_at)
       VALUES (@toEmail, @fromEmail, @name, @link, @username, @country, @subject, @body, @createdAt)`,
    )
    .run({
      toEmail: to,
      fromEmail: (item.fromEmail ?? "").trim(),
      name: (item.name ?? "").trim(),
      link: (item.link ?? "").trim(),
      username: (item.username ?? "").trim(),
      country: (item.country ?? "").trim(),
      subject: item.subject,
      body: item.body,
      createdAt: new Date().toISOString(),
    });
  return toItem(
    db.prepare(`SELECT * FROM send_queue WHERE id = ?`).get(info.lastInsertRowid) as ItemRow,
  );
}

export function listQueue(limit = 500): QueueItem[] {
  return (
    db
      .prepare(`SELECT * FROM send_queue ORDER BY id DESC LIMIT ?`)
      .all(limit) as ItemRow[]
  ).map(toItem);
}

export function queueCounts(): Record<QueueStatus, number> {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS c FROM send_queue GROUP BY status`)
    .all() as { status: QueueStatus; c: number }[];
  const out: Record<QueueStatus, number> = {
    queued: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    canceled: 0,
  };
  for (const r of rows) out[r.status] = r.c;
  return out;
}

export function cancelItem(id: number): boolean {
  return (
    db
      .prepare(
        `UPDATE send_queue SET status = 'canceled' WHERE id = ? AND status = 'queued'`,
      )
      .run(id).changes > 0
  );
}

/** Cancel all still-queued items for an email (used by the card toggle).
 *  Items already sending/sent are left alone. */
export function cancelByEmail(email: string): number {
  return db
    .prepare(
      `UPDATE send_queue SET status = 'canceled' WHERE lower(to_email) = ? AND status = 'queued'`,
    )
    .run(email.trim().toLowerCase()).changes;
}

export function retryItem(id: number): boolean {
  return (
    db
      .prepare(
        `UPDATE send_queue SET status = 'queued', last_error = '' WHERE id = ? AND status IN ('failed','canceled')`,
      )
      .run(id).changes > 0
  );
}

export function clearFinished(): number {
  return db
    .prepare(`DELETE FROM send_queue WHERE status IN ('sent','canceled')`)
    .run().changes;
}

// --- worker-facing ---------------------------------------------------------

/** Atomically claim the oldest queued item (sets it to 'sending'). */
export function claimNext(): QueueItem | null {
  const claim = db.transaction((): ItemRow | null => {
    const row = db
      .prepare(
        `SELECT * FROM send_queue WHERE status = 'queued' ORDER BY id ASC LIMIT 1`,
      )
      .get() as ItemRow | undefined;
    if (!row) return null;
    db.prepare(`UPDATE send_queue SET status = 'sending' WHERE id = ?`).run(row.id);
    return row;
  });
  const row = claim();
  return row ? toItem(row) : null;
}

export function markSent(id: number, messageId: string): void {
  db.prepare(
    `UPDATE send_queue SET status = 'sent', message_id = ?, sent_at = ?, last_error = '' WHERE id = ?`,
  ).run(messageId, new Date().toISOString(), id);
}

export function markFailedOrRequeue(
  id: number,
  error: string,
  maxAttempts: number,
): "requeued" | "failed" {
  const row = db
    .prepare(`SELECT attempts FROM send_queue WHERE id = ?`)
    .get(id) as { attempts: number } | undefined;
  const attempts = (row?.attempts ?? 0) + 1;
  const finalStatus = attempts >= maxAttempts ? "failed" : "queued";
  db.prepare(
    `UPDATE send_queue SET status = ?, attempts = ?, last_error = ? WHERE id = ?`,
  ).run(finalStatus, attempts, error.slice(0, 500), id);
  return finalStatus === "failed" ? "failed" : "requeued";
}

/** Crash recovery: anything left 'sending' from a previous run goes back to
 *  'queued' so it isn't stranded. */
export function resetStuckSending(): number {
  return db
    .prepare(`UPDATE send_queue SET status = 'queued' WHERE status = 'sending'`)
    .run().changes;
}

/** Count sends that actually left today (local day), from the send log — the
 *  authoritative record, so the cap also accounts for manual sends. */
export function sentTodayCount(): number {
  const now = new Date();
  const startLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM send_log WHERE date >= ?`)
    .get(startLocal.toISOString()) as { c: number };
  return row.c;
}

// --- settings --------------------------------------------------------------

type SettingsRow = {
  enabled: number;
  window_start: string;
  window_end: string;
  interval_sec: number;
  jitter_sec: number;
  daily_cap: number;
  rotate_senders: number;
  start_at: string | null;
  fu_delay_min: number;
  local_time_send: number;
  local_start: string;
  local_end: string;
  sender_pool: string;
  per_sender_cap: number;
  bump_enabled: number;
  bump_after_days: number;
  sender_caps: string;
};

function parseSenderPool(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return [
      ...new Set(
        arr
          .filter((x): x is string => typeof x === "string")
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e.includes("@")),
      ),
    ];
  } catch {
    return [];
  }
}

function normalizeSenderCaps(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const email = k.trim().toLowerCase();
    const cap = Math.round(Number(v));
    if (!email.includes("@") || !Number.isFinite(cap) || cap < 1) continue;
    out[email] = Math.min(1000, cap);
  }
  return out;
}

function parseSenderCaps(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    return normalizeSenderCaps(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function getSettings(): QueueSettings {
  const r = db
    .prepare(`SELECT * FROM queue_settings WHERE id = 1`)
    .get() as SettingsRow;
  return {
    enabled: r.enabled === 1,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    intervalSec: r.interval_sec,
    jitterSec: r.jitter_sec,
    dailyCap: r.daily_cap,
    rotateSenders: r.rotate_senders === 1,
    startAt: r.start_at,
    fuDelayMin: r.fu_delay_min,
    localTimeSend: r.local_time_send === 1,
    localStart: r.local_start,
    localEnd: r.local_end,
    senderPool: parseSenderPool(r.sender_pool),
    perSenderCap: r.per_sender_cap,
    bumpEnabled: r.bump_enabled === 1,
    bumpAfterDays: r.bump_after_days,
    senderCaps: parseSenderCaps(r.sender_caps),
  };
}

export function saveSettings(patch: Partial<QueueSettings>): QueueSettings {
  const cur = getSettings();
  const next = { ...cur, ...patch };
  // Clamp to sane ranges so a bad value can't turn the drip into a blast.
  next.intervalSec = Math.max(10, Math.min(3600, Math.round(next.intervalSec)));
  next.jitterSec = Math.max(0, Math.min(1800, Math.round(next.jitterSec)));
  next.dailyCap = Math.max(1, Math.min(1000, Math.round(next.dailyCap)));
  next.fuDelayMin = Math.max(1, Math.min(1440, Math.round(next.fuDelayMin)));
  next.perSenderCap = Math.max(0, Math.min(1000, Math.round(next.perSenderCap)));
  next.bumpAfterDays = Math.max(1, Math.min(60, Math.round(next.bumpAfterDays)));
  // Normalize the sender pool: lowercase, dedup, keep only email-shaped values.
  next.senderPool = [
    ...new Set(
      (next.senderPool ?? [])
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.includes("@")),
    ),
  ];
  next.senderCaps = normalizeSenderCaps(next.senderCaps);
  db.prepare(
    `UPDATE queue_settings SET
       enabled = @enabled, window_start = @windowStart, window_end = @windowEnd,
       interval_sec = @intervalSec, jitter_sec = @jitterSec,
       daily_cap = @dailyCap, rotate_senders = @rotateSenders,
       start_at = @startAt, fu_delay_min = @fuDelayMin,
       local_time_send = @localTimeSend, local_start = @localStart,
       local_end = @localEnd, sender_pool = @senderPool,
       per_sender_cap = @perSenderCap, bump_enabled = @bumpEnabled,
       bump_after_days = @bumpAfterDays, sender_caps = @senderCaps
     WHERE id = 1`,
  ).run({
    enabled: next.enabled ? 1 : 0,
    windowStart: next.windowStart,
    windowEnd: next.windowEnd,
    intervalSec: next.intervalSec,
    jitterSec: next.jitterSec,
    dailyCap: next.dailyCap,
    rotateSenders: next.rotateSenders ? 1 : 0,
    startAt: next.startAt ?? null,
    fuDelayMin: next.fuDelayMin,
    localTimeSend: next.localTimeSend ? 1 : 0,
    localStart: next.localStart,
    localEnd: next.localEnd,
    senderPool: JSON.stringify(next.senderPool),
    perSenderCap: next.perSenderCap,
    bumpEnabled: next.bumpEnabled ? 1 : 0,
    bumpAfterDays: next.bumpAfterDays,
    senderCaps: JSON.stringify(next.senderCaps),
  });
  return next;
}
