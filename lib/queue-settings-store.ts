// The queue-settings store: reads and saves the single-row worker
// configuration (queue_settings), clamping values to sane ranges. The queue
// itself lives in lib/sequences-store.ts; the worker (lib/queue-worker.ts)
// and the queue API read their settings from here.

import { db } from "./db";

export type QueueSettings = {
  enabled: boolean;
  windowStart: string; // "HH:MM"
  windowEnd: string;
  intervalSec: number;
  jitterSec: number;
  dailyCap: number; // by distinct recipient address, not email count
  rotateSenders: boolean;
  startAt: string | null; // ISO — queue kickoff; null = start when enabled
  // Retired default follow-up delay. The pitch is reply-triggered, so no delay
  // is read any more and the setting is gone from the UI. Kept like
  // perSenderCap below: the column/row and old clients keep working.
  fuDelayMin: number;
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
