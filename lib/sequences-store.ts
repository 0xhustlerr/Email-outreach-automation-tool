// Storage for two-step send sequences (opener + optional threaded follow-up).
// Used by both lanes:
//   - 'send'  : opener already sent synchronously by /api/send; this records
//               the sequence and schedules the follow-up.
//   - 'queue' : opener pending; the worker drips it, then the follow-up fires.
// Also the source of truth for the History status ticks.

import { db } from "./db";
import { resolveLocation } from "./country";

export type StepStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "scheduled"
  | "waiting"
  | "skipped";

export type Sequence = {
  id: number;
  lane: "send" | "queue";
  toEmail: string;
  ccEmail: string;
  fromEmail: string;
  name: string;
  link: string;
  linkLinkedin: string;
  linkGithub: string;
  username: string;
  country: string;
  countryStd: string;
  timezone: string;
  tzSource: string;
  opSubject: string;
  opBody: string;
  opStatus: StepStatus;
  opMessageId: string;
  opSentAt: string | null;
  opSendAfter: string | null;
  hasFollow: boolean;
  fuSubject: string;
  fuBody: string;
  fuDelayMin: number;
  fuStatus: StepStatus;
  fuMessageId: string;
  fuSentAt: string | null;
  fuSendAfter: string | null;
  bumpSentAt: string | null;
  attempts: number;
  lastError: string;
  createdAt: string;
};

type Row = {
  id: number;
  lane: "send" | "queue";
  to_email: string;
  cc_email: string;
  from_email: string;
  name: string;
  link: string;
  link_linkedin: string;
  link_github: string;
  username: string;
  country: string;
  country_std: string;
  timezone: string;
  tz_source: string;
  op_subject: string;
  op_body: string;
  op_status: StepStatus;
  op_message_id: string;
  op_sent_at: string | null;
  op_send_after: string | null;
  has_follow: number;
  fu_subject: string;
  fu_body: string;
  fu_delay_min: number;
  fu_status: StepStatus;
  fu_message_id: string;
  fu_sent_at: string | null;
  fu_send_after: string | null;
  bump_sent_at: string | null;
  attempts: number;
  last_error: string;
  created_at: string;
};

function toSeq(r: Row): Sequence {
  return {
    id: r.id,
    lane: r.lane,
    toEmail: r.to_email,
    ccEmail: r.cc_email ?? "",
    fromEmail: r.from_email,
    name: r.name,
    link: r.link,
    linkLinkedin: r.link_linkedin ?? "",
    linkGithub: r.link_github ?? "",
    username: r.username,
    country: r.country,
    countryStd: r.country_std,
    timezone: r.timezone,
    tzSource: r.tz_source,
    opSubject: r.op_subject,
    opBody: r.op_body,
    opStatus: r.op_status,
    opMessageId: r.op_message_id,
    opSentAt: r.op_sent_at,
    opSendAfter: r.op_send_after,
    hasFollow: r.has_follow === 1,
    fuSubject: r.fu_subject,
    fuBody: r.fu_body,
    fuDelayMin: r.fu_delay_min,
    fuStatus: r.fu_status,
    fuMessageId: r.fu_message_id,
    fuSentAt: r.fu_sent_at,
    fuSendAfter: r.fu_send_after,
    bumpSentAt: r.bump_sent_at,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
  };
}

export type SequenceInput = {
  toEmail: string;
  /** Optional second recipient, CC'd on the opener and the follow-up. */
  ccEmail?: string;
  fromEmail: string;
  name?: string;
  link?: string;
  linkLinkedin?: string;
  linkGithub?: string;
  username?: string;
  country?: string;
  opSubject: string;
  opBody: string;
  followUp?: { subject: string; body: string; delayMin: number };
  // Location signals for scheduling: the author's commit UTC offset (minutes)
  // and any discovered phones. Combined with `country`/location by the resolver.
  commitOffsetMin?: number | null;
  phones?: string[];
};

/** Resolve the best country + timezone for a sequence from all signals. */
function resolveSeqLocation(input: SequenceInput) {
  const r = resolveLocation({
    commitOffsetMin: input.commitOffsetMin,
    phones: input.phones,
    location: input.country ?? "",
  });
  return {
    countryStd: r.country,
    timezone: r.timezone,
    tzSource: r.source,
  };
}

const insertStmt = () =>
  db.prepare(
    `INSERT INTO sequences (
       lane, to_email, cc_email, from_email, name, link, link_linkedin, link_github,
       username, country, country_std, timezone, tz_source,
       op_subject, op_body, op_status, op_message_id, op_sent_at, op_send_after,
       has_follow, fu_subject, fu_body, fu_delay_min, fu_status, fu_send_after,
       created_at
     ) VALUES (
       @lane, @toEmail, @ccEmail, @fromEmail, @name, @link, @linkLinkedin, @linkGithub,
       @username, @country, @countryStd, @timezone, @tzSource,
       @opSubject, @opBody, @opStatus, @opMessageId, @opSentAt, @opSendAfter,
       @hasFollow, @fuSubject, @fuBody, @fuDelayMin, @fuStatus, @fuSendAfter,
       @createdAt
     )`,
  );

/** SEND lane: the opener has already gone out (synchronously in the route).
 *  Record it and schedule the follow-up. */
export function recordSentSequence(
  input: SequenceInput & { opMessageId: string },
): Sequence {
  const now = new Date().toISOString();
  const hasFollow = !!input.followUp;
  const fuSendAfter = hasFollow
    ? new Date(Date.now() + (input.followUp!.delayMin || 30) * 60_000).toISOString()
    : null;
  const loc = resolveSeqLocation(input);
  const info = insertStmt().run({
    lane: "send",
    toEmail: input.toEmail.trim().toLowerCase(),
    ccEmail: (input.ccEmail ?? "").trim().toLowerCase(),
    fromEmail: input.fromEmail,
    name: input.name ?? "",
    link: input.link ?? "",
    linkLinkedin: input.linkLinkedin ?? "",
    linkGithub: input.linkGithub ?? "",
    username: input.username ?? "",
    country: input.country ?? "",
    countryStd: loc.countryStd,
    timezone: loc.timezone,
    tzSource: loc.tzSource,
    opSubject: input.opSubject,
    opBody: input.opBody,
    opStatus: "sent",
    opMessageId: input.opMessageId,
    opSentAt: now,
    opSendAfter: null,
    hasFollow: hasFollow ? 1 : 0,
    fuSubject: input.followUp?.subject ?? "",
    fuBody: input.followUp?.body ?? "",
    fuDelayMin: input.followUp?.delayMin ?? 30,
    fuStatus: hasFollow ? "scheduled" : "skipped",
    fuSendAfter,
    createdAt: now,
  });
  return getSequence(Number(info.lastInsertRowid))!;
}

/** QUEUE lane: opener pending; the worker will drip it starting at startAt.
 *  allowResend bypasses the "already emailed" guard (used by the re-engage
 *  from-history campaign, which deliberately targets past contacts). */
export function enqueueSequence(
  input: SequenceInput,
  startAt: string | null,
  opts: { allowResend?: boolean } = {},
): Sequence | { skipped: true; reason: string } {
  const to = input.toEmail.trim().toLowerCase();
  const dup = db
    .prepare(
      `SELECT 1 FROM sequences WHERE to_email = ? AND op_status IN ('pending','sending') LIMIT 1`,
    )
    .get(to);
  if (dup) return { skipped: true, reason: "already queued" };
  if (!opts.allowResend) {
    const alreadySent = db
      .prepare(`SELECT 1 FROM send_log WHERE lower(contact) = ? LIMIT 1`)
      .get(to);
    if (alreadySent) return { skipped: true, reason: "already emailed" };
  }

  const now = new Date().toISOString();
  const hasFollow = !!input.followUp;
  const loc = resolveSeqLocation(input);
  const info = insertStmt().run({
    lane: "queue",
    toEmail: to,
    ccEmail: (input.ccEmail ?? "").trim().toLowerCase(),
    fromEmail: input.fromEmail,
    name: input.name ?? "",
    link: input.link ?? "",
    linkLinkedin: input.linkLinkedin ?? "",
    linkGithub: input.linkGithub ?? "",
    username: input.username ?? "",
    country: input.country ?? "",
    countryStd: loc.countryStd,
    timezone: loc.timezone,
    tzSource: loc.tzSource,
    opSubject: input.opSubject,
    opBody: input.opBody,
    opStatus: "pending",
    opMessageId: "",
    opSentAt: null,
    opSendAfter: startAt,
    hasFollow: hasFollow ? 1 : 0,
    fuSubject: input.followUp?.subject ?? "",
    fuBody: input.followUp?.body ?? "",
    fuDelayMin: input.followUp?.delayMin ?? 30,
    fuStatus: hasFollow ? "waiting" : "skipped",
    fuSendAfter: null,
    createdAt: now,
  });
  return getSequence(Number(info.lastInsertRowid))!;
}

export function getSequence(id: number): Sequence | null {
  const r = db.prepare(`SELECT * FROM sequences WHERE id = ?`).get(id) as
    | Row
    | undefined;
  return r ? toSeq(r) : null;
}

export function listSequences(limit = 500): Sequence[] {
  return (
    db.prepare(`SELECT * FROM sequences ORDER BY id DESC LIMIT ?`).all(limit) as Row[]
  ).map(toSeq);
}

// --- worker-facing ---------------------------------------------------------

// How many due candidates to scan when an eligibility filter is in play (so a
// run of "asleep" contacts can be skipped over to reach an eligible one).
const CLAIM_SCAN = 200;

/** Claim the next queue-lane opener that's due AND passes `eligible` (used for
 *  local-time gating). Scans candidates in send order and claims the first
 *  eligible one atomically. */
export function claimNextQueuedOpener(
  eligible?: (s: Sequence) => boolean,
): Sequence | null {
  const claim = db.transaction((): Row | null => {
    const nowIso = new Date().toISOString();
    const rows = db
      .prepare(
        `SELECT * FROM sequences
         WHERE lane = 'queue' AND op_status = 'pending'
           AND (op_send_after IS NULL OR op_send_after <= ?)
         ORDER BY id ASC LIMIT ?`,
      )
      .all(nowIso, eligible ? CLAIM_SCAN : 1) as Row[];
    for (const row of rows) {
      if (eligible && !eligible(toSeq(row))) continue;
      db.prepare(`UPDATE sequences SET op_status = 'sending' WHERE id = ?`).run(row.id);
      return row;
    }
    return null;
  });
  const r = claim();
  return r ? toSeq(r) : null;
}

/** Put a claimed opener back to 'pending' (e.g. when no eligible sender is
 *  available right now, so it retries later instead of stranding as 'sending'). */
export function revertOpenerToPending(id: number): void {
  db.prepare(
    `UPDATE sequences SET op_status = 'pending' WHERE id = ? AND op_status = 'sending'`,
  ).run(id);
}

/** Put a claimed follow-up back to 'scheduled' — the follow-up twin of
 *  revertOpenerToPending, for when the send was abandoned for a reason that is
 *  about the ACCOUNT (blocked for the day) rather than this contact, so no
 *  attempt should be burned toward the permanent 'failed' state. */
export function revertFollowupToScheduled(id: number): void {
  db.prepare(
    `UPDATE sequences SET fu_status = 'scheduled' WHERE id = ? AND fu_status = 'sending'`,
  ).run(id);
}

/** Un-stamp an optimistically-claimed bump so it can fire later. claimDueBump
 *  sets bump_sent_at BEFORE the send and only ever claims rows where it is
 *  NULL, so without this a failed bump is silently lost forever. */
export function revertBump(id: number): void {
  db.prepare(`UPDATE sequences SET bump_sent_at = NULL WHERE id = ?`).run(id);
}

/** Claim a follow-up whose delay has elapsed AND passes `eligible`. */
export function claimDueFollowup(
  eligible?: (s: Sequence) => boolean,
): Sequence | null {
  const claim = db.transaction((): Row | null => {
    const nowIso = new Date().toISOString();
    const rows = db
      .prepare(
        `SELECT * FROM sequences
         WHERE fu_status = 'scheduled' AND fu_send_after IS NOT NULL
           AND fu_send_after <= ?
         ORDER BY fu_send_after ASC LIMIT ?`,
      )
      .all(nowIso, eligible ? CLAIM_SCAN : 1) as Row[];
    for (const row of rows) {
      if (eligible && !eligible(toSeq(row))) continue;
      db.prepare(`UPDATE sequences SET fu_status = 'sending' WHERE id = ?`).run(row.id);
      return row;
    }
    return null;
  });
  const r = claim();
  return r ? toSeq(r) : null;
}

/** Claim a scheduled follow-up whose contact has ALREADY replied to the opener,
 *  so the pitch goes out FAST (within a few minutes) instead of waiting the
 *  full delay. Ignores fu_send_after; only requires the opener to be at least
 *  `minAgeMin` old so we never reply instantly. Oldest opener first. */
export function claimRepliedFollowup(
  minAgeMin = 3,
  eligible?: (s: Sequence) => boolean,
): Sequence | null {
  const claim = db.transaction((): Row | null => {
    const cutoff = new Date(Date.now() - minAgeMin * 60_000).toISOString();
    const rows = db
      .prepare(
        `SELECT * FROM sequences
         WHERE fu_status = 'scheduled' AND op_sent_at IS NOT NULL
           AND op_sent_at <= ?
           AND EXISTS (
             SELECT 1 FROM send_log l
             WHERE lower(l.contact) LIKE '%' || lower(sequences.to_email) || '%'
               AND (l.active = 1 OR l.replied = 1)
           )
         ORDER BY op_sent_at ASC LIMIT ?`,
      )
      .all(cutoff, eligible ? CLAIM_SCAN : 1) as Row[];
    for (const row of rows) {
      if (eligible && !eligible(toSeq(row))) continue;
      db.prepare(`UPDATE sequences SET fu_status = 'sending' WHERE id = ?`).run(row.id);
      return row;
    }
    return null;
  });
  const r = claim();
  return r ? toSeq(r) : null;
}

/** Claim a scheduled follow-up whose contact has NOT replied and whose opener
 *  is at least `afterDays` old and hasn't been bumped yet — for the one-time
 *  link-free bump. Sets bump_sent_at optimistically (claim marker) but leaves
 *  fu_status = 'scheduled' so a later reply still triggers the pitch. */
export function claimDueBump(
  afterDays: number,
  eligible?: (s: Sequence) => boolean,
): Sequence | null {
  const claim = db.transaction((): Row | null => {
    const cutoff = new Date(Date.now() - afterDays * 86_400_000).toISOString();
    const rows = db
      .prepare(
        `SELECT * FROM sequences
         WHERE fu_status = 'scheduled' AND bump_sent_at IS NULL
           AND op_sent_at IS NOT NULL AND op_sent_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM send_log l
             WHERE lower(l.contact) LIKE '%' || lower(sequences.to_email) || '%'
               AND (l.active = 1 OR l.replied = 1)
           )
         ORDER BY op_sent_at ASC LIMIT ?`,
      )
      .all(cutoff, eligible ? CLAIM_SCAN : 1) as Row[];
    for (const row of rows) {
      if (eligible && !eligible(toSeq(row))) continue;
      db.prepare(`UPDATE sequences SET bump_sent_at = ? WHERE id = ?`).run(
        new Date().toISOString(),
        row.id,
      );
      return row;
    }
    return null;
  });
  const r = claim();
  return r ? toSeq(r) : null;
}

/** The account that most recently emailed this contact (lowercased), or "".
 *  Used to send a re-engaged contact's new opener from a DIFFERENT account. */
export function lastSenderForContact(email: string): string {
  const e = email.trim().toLowerCase();
  if (!e) return "";
  const r = db
    .prepare(
      `SELECT lower(sender) AS s FROM send_log
       WHERE lower(contact) LIKE '%' || ? || '%' AND sender <> ''
       ORDER BY date DESC LIMIT 1`,
    )
    .get(e) as { s: string } | undefined;
  return r?.s ?? "";
}

/** How many due queue openers were most recently emailed by `sender` — i.e.
 *  would be BLOCKED by the hard rule when `sender` is the only free account
 *  (their only different account is capped). For the "waiting" status line. */
export function pendingOpenersLastSentBy(sender: string): number {
  const s = sender.trim().toLowerCase();
  if (!s) return 0;
  const nowIso = new Date().toISOString();
  const r = db
    .prepare(
      `SELECT COUNT(*) AS c FROM sequences seq
       WHERE seq.lane = 'queue' AND seq.op_status = 'pending'
         AND (seq.op_send_after IS NULL OR seq.op_send_after <= ?)
         AND ? = (
           SELECT lower(l.sender) FROM send_log l
           WHERE lower(l.contact) LIKE '%' || lower(seq.to_email) || '%'
             AND l.sender <> '' ORDER BY l.date DESC LIMIT 1
         )`,
    )
    .get(nowIso, s) as { c: number };
  return r.c;
}

export function markOpenerSent(
  id: number,
  messageId: string,
  sender?: string,
): void {
  const seq = getSequence(id);
  if (!seq) return;
  const now = new Date().toISOString();
  const fuSendAfter = seq.hasFollow
    ? new Date(Date.now() + (seq.fuDelayMin || 30) * 60_000).toISOString()
    : null;
  // Persist the account the opener actually went out from so the threaded
  // follow-up replies from the SAME address (critical when the sender was
  // picked from a pool / rotation rather than the item's stored from_email).
  const from = (sender ?? "").trim();
  db.prepare(
    `UPDATE sequences SET
       op_status = 'sent', op_message_id = ?, op_sent_at = ?, last_error = '',
       from_email = CASE WHEN ? <> '' THEN ? ELSE from_email END,
       fu_status = CASE WHEN has_follow = 1 THEN 'scheduled' ELSE 'skipped' END,
       fu_send_after = ?
     WHERE id = ?`,
  ).run(messageId, now, from, from, fuSendAfter, id);
}

export function markOpenerFailed(
  id: number,
  error: string,
  maxAttempts: number,
): "retry" | "failed" {
  const row = db
    .prepare(`SELECT attempts FROM sequences WHERE id = ?`)
    .get(id) as { attempts: number } | undefined;
  const attempts = (row?.attempts ?? 0) + 1;
  if (attempts >= maxAttempts) {
    db.prepare(
      `UPDATE sequences SET op_status = 'failed', fu_status = 'skipped', attempts = ?, last_error = ? WHERE id = ?`,
    ).run(attempts, error.slice(0, 500), id);
    return "failed";
  }
  db.prepare(
    `UPDATE sequences SET op_status = 'pending', attempts = ?, last_error = ? WHERE id = ?`,
  ).run(attempts, error.slice(0, 500), id);
  return "retry";
}

export function markFollowupSent(id: number, messageId: string): void {
  db.prepare(
    `UPDATE sequences SET fu_status = 'sent', fu_message_id = ?, fu_sent_at = ?, last_error = '' WHERE id = ?`,
  ).run(messageId, new Date().toISOString(), id);
}

export function markFollowupFailed(
  id: number,
  error: string,
  maxAttempts: number,
): "retry" | "failed" {
  const row = db
    .prepare(`SELECT attempts FROM sequences WHERE id = ?`)
    .get(id) as { attempts: number } | undefined;
  const attempts = (row?.attempts ?? 0) + 1;
  const status = attempts >= maxAttempts ? "failed" : "scheduled";
  db.prepare(
    `UPDATE sequences SET fu_status = ?, attempts = ?, last_error = ? WHERE id = ?`,
  ).run(status, attempts, error.slice(0, 500), id);
  return status === "failed" ? "failed" : "retry";
}

/** One-time: resolve country/timezone for sequences that were enqueued before
 *  the location resolver existed (timezone still ''). Looks up the contact's
 *  country from the send log and resolves. Safe to run repeatedly. */
export function backfillSequenceLocations(): number {
  const rows = db
    .prepare(
      `SELECT id, to_email, country FROM sequences
       WHERE timezone = '' AND op_status IN ('pending','sending','scheduled')
          OR (timezone = '' AND fu_status = 'scheduled')`,
    )
    .all() as { id: number; to_email: string; country: string }[];
  if (rows.length === 0) return 0;
  const lookup = db.prepare(
    `SELECT country FROM send_log WHERE lower(contact) LIKE ? AND TRIM(country) != ''
     ORDER BY date DESC LIMIT 1`,
  );
  const upd = db.prepare(
    `UPDATE sequences SET country_std = ?, timezone = ?, tz_source = ? WHERE id = ?`,
  );
  const run = db.transaction(() => {
    let n = 0;
    for (const r of rows) {
      let country = r.country;
      if (!country.trim()) {
        const hit = lookup.get(`%${r.to_email.toLowerCase()}%`) as
          | { country: string }
          | undefined;
        country = hit?.country ?? "";
      }
      const loc = resolveLocation({ location: country });
      if (loc.timezone) {
        upd.run(loc.country, loc.timezone, loc.source, r.id);
        n++;
      }
    }
    return n;
  });
  return run();
}

/** Crash recovery on boot. */
export function resetStuckSequences(): number {
  const a = db
    .prepare(`UPDATE sequences SET op_status = 'pending' WHERE op_status = 'sending'`)
    .run().changes;
  const b = db
    .prepare(`UPDATE sequences SET fu_status = 'scheduled' WHERE fu_status = 'sending'`)
    .run().changes;
  return a + b;
}

/** Distinct recipient addresses emailed today (local day) — the daily cap is
 *  by address, so a two-step to one client counts once. */
export function distinctClientsToday(): number {
  const now = new Date();
  const startLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT lower(contact)) AS c FROM send_log WHERE date >= ?`,
    )
    .get(startLocal.toISOString()) as { c: number };
  return row.c;
}

/** Distinct recipient contacts emailed today (local day) per sender address —
 *  drives the per-sender daily cap so no single account over-sends. Keyed by
 *  lowercased sender email. */
export function sentTodayBySender(): Record<string, number> {
  const now = new Date();
  const startLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rows = db
    .prepare(
      `SELECT lower(sender) AS s, COUNT(DISTINCT lower(contact)) AS c
       FROM send_log WHERE date >= ? AND sender <> '' GROUP BY lower(sender)`,
    )
    .all(startLocal.toISOString()) as { s: string; c: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.s] = r.c;
  return out;
}

/** Has this address already been counted against today's cap? Follow-ups to an
 *  already-emailed client must not consume a fresh cap slot. */
export function clientCountedToday(email: string): boolean {
  const now = new Date();
  const startLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return !!db
    .prepare(
      `SELECT 1 FROM send_log WHERE lower(contact) = ? AND date >= ? LIMIT 1`,
    )
    .get(email.trim().toLowerCase(), startLocal.toISOString());
}

export function cancelSequenceByEmail(email: string): number {
  return db
    .prepare(
      `UPDATE sequences SET op_status = 'failed', fu_status = 'skipped', last_error = 'canceled'
       WHERE lower(to_email) = ? AND lane = 'queue' AND op_status = 'pending'`,
    )
    .run(email.trim().toLowerCase()).changes;
}

export function sequenceCounts() {
  const rows = db
    .prepare(
      `SELECT
         SUM(CASE WHEN lane='queue' AND op_status='pending' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN op_status='sent' THEN 1 ELSE 0 END) AS openersSent,
         SUM(CASE WHEN fu_status='scheduled' THEN 1 ELSE 0 END) AS followupsPending,
         SUM(CASE WHEN fu_status='sent' THEN 1 ELSE 0 END) AS followupsSent,
         SUM(CASE WHEN op_status='failed' OR fu_status='failed' THEN 1 ELSE 0 END) AS failed
       FROM sequences`,
    )
    .get() as Record<string, number | null>;
  return {
    queued: rows.queued ?? 0,
    openersSent: rows.openersSent ?? 0,
    followupsPending: rows.followupsPending ?? 0,
    followupsSent: rows.followupsSent ?? 0,
    failed: rows.failed ?? 0,
  };
}

export function cancelSequence(id: number): boolean {
  return (
    db
      .prepare(
        `UPDATE sequences SET op_status = 'failed', fu_status = 'skipped', last_error = 'canceled'
         WHERE id = ? AND lane = 'queue' AND op_status = 'pending'`,
      )
      .run(id).changes > 0
  );
}

export function clearFinishedSequences(): number {
  return db
    .prepare(
      `DELETE FROM sequences WHERE op_status IN ('sent','failed')
       AND fu_status IN ('sent','failed','skipped')`,
    )
    .run().changes;
}

/** Bulk "clear queue": cancel EVERY not-yet-sent queue-lane opener at once.
 *  Already-sent openers and their scheduled follow-ups are left untouched
 *  (those emails are out; use cancelAllPendingFollowups to stop the replies). */
export function cancelAllQueued(): number {
  return db
    .prepare(
      `UPDATE sequences SET op_status = 'failed', fu_status = 'skipped', last_error = 'canceled'
       WHERE lane = 'queue' AND op_status = 'pending'`,
    )
    .run().changes;
}

/** Stop every follow-up that is scheduled but hasn't sent yet — e.g. when the
 *  openers landed in spam and you don't want the threaded reply to follow. */
export function cancelAllPendingFollowups(): number {
  return db
    .prepare(
      `UPDATE sequences SET fu_status = 'skipped', last_error = 'canceled'
       WHERE fu_status = 'scheduled'`,
    )
    .run().changes;
}

/** Re-rotate the openers of every not-yet-sent queue item WITHOUT removing
 *  them: rewrite each pending opener from `openers` round-robin, re-rendering
 *  {{name}}/{{url}} from the item's stored fields. Lets you swap in a fresh set
 *  of openers (and spread them ~evenly) after a batch is already queued. */
export function rotateQueuedOpeners(
  openers: { subject: string; body: string }[],
): number {
  const list = openers
    .map((o) => ({ subject: (o.subject ?? "").trim(), body: o.body ?? "" }))
    .filter((o) => o.subject && o.body.trim());
  if (list.length === 0) return 0;

  const rows = db
    .prepare(
      `SELECT id, name, link, link_linkedin, link_github, username FROM sequences
       WHERE lane = 'queue' AND op_status = 'pending' ORDER BY id ASC`,
    )
    .all() as {
    id: number;
    name: string;
    link: string;
    link_linkedin: string;
    link_github: string;
    username: string;
  }[];

  const sub = (t: string, vars: Record<string, string>) =>
    t.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? "");
  const upd = db.prepare(
    `UPDATE sequences SET op_subject = ?, op_body = ? WHERE id = ?`,
  );
  const tx = db.transaction(() => {
    rows.forEach((r, i) => {
      const op = list[i % list.length];
      const vars = {
        name: displayName(r.name),
        ...senderVars(),
        ...urlVars({
          upwork: r.link,
          linkedin: r.link_linkedin,
          github: r.link_github,
          username: r.username,
        }),
      };
      upd.run(sub(op.subject, vars), sub(op.body, vars), r.id);
    });
  });
  tx();
  return rows.length;
}

/** Template vars that keep the sender placeholders INTACT when a body is
 *  rendered at queue time. The mailer is the single choke point that fills
 *  them (from the account that actually sends), so anything that renders a
 *  template before the send must map them back to themselves — otherwise
 *  `substitute` treats them as unknown and blanks them, and the email goes out
 *  signed with nothing. */
export function senderVars(): Record<string, string> {
  return { sender: "{{sender}}", sender_email: "{{sender_email}}" };
}

/** Template vars for the URL placeholders. {{url}} stays an alias of the
 *  Upwork link (pre-existing templates keep working); {{url_github}} falls
 *  back to the profile URL derived from the GitHub username. */
export function urlVars(links: {
  upwork?: string;
  linkedin?: string;
  github?: string;
  username?: string;
}): Record<string, string> {
  const upwork = (links.upwork ?? "").trim();
  const github =
    (links.github ?? "").trim() ||
    ((links.username ?? "").trim()
      ? `https://github.com/${(links.username ?? "").trim()}`
      : "");
  return {
    url: upwork,
    url_upwork: upwork,
    url_linkedin: (links.linkedin ?? "").trim(),
    url_github: github,
  };
}

/** A safe first name for {{name}}: falls back to "there" when the stored name
 *  is missing or is actually a URL/email/handle that leaked into the field
 *  (so an opener never reads "Hi https://upwork.com/…"). */
export function displayName(raw: string | null | undefined): string {
  const n = (raw ?? "").trim();
  if (!n) return "there";
  if (/^https?:|:\/\/|www\.|@|\.(com|net|io|org|dev|co|me)\b/i.test(n)) {
    return "there";
  }
  if (n.length > 40) return "there";
  return n;
}

/** Per-address sequence status for the History ticks. */
export type SequenceTick = {
  opSent: boolean;
  fuSent: boolean;
  hasFollow: boolean;
  failed: boolean;
  opSentAt: string | null;
  fuSentAt: string | null;
};

export function sequenceTicksByEmail(): Record<string, SequenceTick> {
  const rows = db
    .prepare(
      `SELECT to_email, op_status, fu_status, has_follow, op_sent_at, fu_sent_at
       FROM sequences ORDER BY id ASC`,
    )
    .all() as {
    to_email: string;
    op_status: StepStatus;
    fu_status: StepStatus;
    has_follow: number;
    op_sent_at: string | null;
    fu_sent_at: string | null;
  }[];
  const out: Record<string, SequenceTick> = {};
  for (const r of rows) {
    // Latest sequence per address wins.
    out[r.to_email.toLowerCase()] = {
      opSent: r.op_status === "sent",
      fuSent: r.fu_status === "sent",
      hasFollow: r.has_follow === 1,
      failed: r.op_status === "failed" || r.fu_status === "failed",
      opSentAt: r.op_sent_at,
      fuSentAt: r.fu_sent_at,
    };
  }
  return out;
}
