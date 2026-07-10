// Idle-time avatar prefetcher.
//
// Works through every contact in the send_log that has no cached avatar yet,
// fetching one photo at a time through the shared throttled unavatar queue -
// but ONLY while the app is idle. User-driven API routes (scan, discover,
// send, gmail reads, on-demand avatars) call markUserActivity(); the loop
// pauses immediately and resumes IDLE_AFTER_MS after the last activity.
//
// Contacts with no public photo are recorded in avatar_negative so they are
// skipped for NEGATIVE_TTL_DAYS instead of being retried forever. The loop is
// started once per server process from instrumentation.ts.

import { db } from "./db";
import {
  fetchAvatarFromUpstream,
  getCachedAvatar,
  isNegativeCached,
  keyFor,
  unavatarLimitedUntilMs,
} from "./avatar-service";

const IDLE_AFTER_MS = 3 * 60_000; // resume 3 min after the last user action
const NOTHING_TO_DO_SLEEP_MS = 10 * 60_000; // recheck for new contacts
const BUSY_POLL_MS = 15_000;
const NEGATIVE_TTL_DAYS = 7;

type PrefetchState = {
  started: boolean;
  gen: number;
  lastUserActivityMs: number;
  // Legacy field polled by loops from before the generation mechanism -
  // pinned far in the future so any such stranded loop stays paused.
  lastActivityMs?: number;
  fetched: number;
  noAvatar: number;
  current: string | null;
};

const globalForPrefetch = globalThis as unknown as {
  __avatarPrefetch?: PrefetchState;
};
const state: PrefetchState = globalForPrefetch.__avatarPrefetch ?? {
  started: false,
  gen: 0,
  // Treat server boot as activity so the loop never races app startup.
  lastUserActivityMs: Date.now(),
  fetched: 0,
  noAvatar: 0,
  current: null,
};
globalForPrefetch.__avatarPrefetch = state;

// Dev hot reload keeps old module instances alive: without this, an edited
// file leaves the PREVIOUS loop running its stale code forever. Each module
// load claims a new generation; loops exit as soon as theirs is superseded.
// Guard against undefined AND NaN - state may predate this field.
state.gen = (Number.isFinite(state.gen) ? state.gen : 0) + 1;
state.started = false;
state.lastUserActivityMs ??= Date.now();
state.lastActivityMs = Number.MAX_SAFE_INTEGER; // strand pre-gen loops
const MY_GEN = state.gen;

/** Called by user-driven API routes. Pauses the prefetcher. */
export function markUserActivity(): void {
  state.lastUserActivityMs = Date.now();
}

function isIdle(): boolean {
  return Date.now() - state.lastUserActivityMs >= IDLE_AFTER_MS;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function pendingEmails(): string[] {
  const contacts = db
    .prepare(`SELECT DISTINCT contact FROM send_log WHERE contact != ''`)
    .all() as { contact: string }[];
  const have = new Set(
    (db.prepare(`SELECT key FROM avatars`).all() as { key: string }[]).map(
      (r) => r.key,
    ),
  );
  const cutoff = new Date(
    Date.now() - NEGATIVE_TTL_DAYS * 24 * 3_600_000,
  ).toISOString();
  const negative = new Set(
    (
      db
        .prepare(`SELECT email FROM avatar_negative WHERE attempted_at > ?`)
        .all(cutoff) as { email: string }[]
    ).map((r) => r.email),
  );

  const out: string[] = [];
  const seen = new Set<string>();
  for (const { contact } of contacts) {
    // Multi-address cells use the same separators as reply-sync.
    for (const part of contact.split(/[/,;]/)) {
      const email = part.trim().toLowerCase();
      if (!EMAIL_RE.test(email) || seen.has(email)) continue;
      seen.add(email);
      if (have.has(keyFor(email)) || negative.has(email)) continue;
      out.push(email);
    }
  }
  return out;
}

function recordNoAvatar(email: string): void {
  try {
    db.prepare(
      `INSERT INTO avatar_negative (email, attempted_at) VALUES (?, ?)
       ON CONFLICT(email) DO UPDATE SET attempted_at = excluded.attempted_at`,
    ).run(email, new Date().toISOString());
  } catch {
    // Best-effort.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loop(): Promise<void> {
  for (;;) {
    if (state.gen !== MY_GEN) return; // superseded by a newer module load
    try {
      if (!isIdle()) {
        await sleep(BUSY_POLL_MS);
        continue;
      }

      const pending = pendingEmails();
      if (pending.length === 0) {
        state.current = null;
        await sleep(NOTHING_TO_DO_SLEEP_MS);
        continue;
      }

      console.log(
        `[avatar-prefetch] idle - ${pending.length} contacts without avatars, fetching...`,
      );

      for (const email of pending) {
        if (state.gen !== MY_GEN) return; // superseded mid-pass
        if (!isIdle()) break; // user came back - stop mid-list, resume later

        state.current = email;
        if (getCachedAvatar(email)) continue; // fetched on demand meanwhile
        if (isNegativeCached(email)) continue; // transient failure - next pass

        const { status } = await fetchAvatarFromUpstream(email);
        if (status === "ok") {
          state.fetched++;
        } else if (status === "no-avatar") {
          // Only a definitive 404 goes into the persistent skip list - a
          // rate-limit or network blip must not hide a contact for a week.
          state.noAvatar++;
          recordNoAvatar(email);
        }

        // unavatar quota exhausted (often ~24h). Gravatar-only passes waste
        // little, but most photos need unavatar - sleep until it resets.
        const limitedUntil = unavatarLimitedUntilMs();
        if (limitedUntil > Date.now()) {
          const mins = Math.round((limitedUntil - Date.now()) / 60_000);
          console.log(
            `[avatar-prefetch] unavatar daily quota hit - pausing ${mins} min (photos so far: ${state.fetched})`,
          );
          state.current = null;
          await sleep(Math.min(limitedUntil - Date.now(), 6 * 3600_000));
          break;
        }

        const done = state.fetched + state.noAvatar;
        if (done > 0 && done % 50 === 0) {
          console.log(
            `[avatar-prefetch] progress: ${state.fetched} photos saved, ${state.noAvatar} contacts without a public photo`,
          );
        }
      }
      state.current = null;
    } catch (err) {
      console.warn(
        "[avatar-prefetch] pass failed, retrying later:",
        err instanceof Error ? err.message : err,
      );
      await sleep(BUSY_POLL_MS);
    }
  }
}

/** Idempotent - safe to call from instrumentation on every boot/reload. */
export function startAvatarPrefetchLoop(): void {
  if (state.started) return;
  state.started = true;
  console.log(
    `[avatar-prefetch] armed - runs after ${IDLE_AFTER_MS / 60_000} min of inactivity`,
  );
  void loop();
}

export function avatarPrefetchStatus() {
  const limitedUntil = unavatarLimitedUntilMs();
  return {
    running: state.started,
    gen: state.gen,
    idle: isIdle(),
    idleForMs: Date.now() - state.lastUserActivityMs,
    current: state.current,
    fetchedThisSession: state.fetched,
    noAvatarThisSession: state.noAvatar,
    pending: pendingEmails().length,
    unavatarQuotaExhausted: limitedUntil > Date.now(),
    unavatarRetryInMin:
      limitedUntil > Date.now()
        ? Math.round((limitedUntil - Date.now()) / 60_000)
        : 0,
  };
}

// Self-start on first import (any user-driven route loads this module), so
// the loop also arms on a dev server that was already running when the file
// was added. instrumentation.ts covers clean boots. Idempotent either way.
startAvatarPrefetchLoop();
