// Server-owned reply sync. One loop per server process runs syncRepliesToSheet
// on a fixed cadence and caches the result; clients READ that result instead of
// each driving their own sync.
//
// Before this, every open browser tab AND the tray each POSTed /api/sync-replies
// on its own timer with no in-flight guard, so N clients meant N concurrent
// full-inbox Gmail scans and N racing batch writes to the same sheet rows. It
// also forced the notifications/replies split in ReplySyncResult, because two
// clients sharing one server-persisted id map would consume each other's
// "what's new" flag.
//
// Same shape as bounce-watch (generation guard against dev-mode double-arm,
// exponential backoff on Gmail failures) because it has the same job: a
// long-lived background scanner over the connected inboxes.

import {
  clearGmailTokenCache,
  isGmailReplySyncConfigured,
  verifyReplySyncAuth,
} from "./gmail";
import type {
  InboxScanError,
  ReplyNotification,
  ReplySyncResult,
} from "./reply-alerts";
import {
  loadPersistedMessageIds,
  savePersistedMessageIds,
} from "./reply-sync-persist";
import { syncRepliesToSheet } from "./reply-sync";

const SYNC_MS = Math.max(
  30_000,
  Number(process.env.NEXT_PUBLIC_REPLY_SYNC_MS ?? "60000") || 60_000,
);
const MAX_BACKOFF_MS = 900_000; // 15 min after repeated Gmail failures
const FIRST_RUN_DELAY_MS = 12_000;

export type ReplySyncSnapshot = {
  configured: boolean;
  /** Rows that currently have a reply (full set, not a delta). */
  replies: ReplyNotification[];
  /**
   * Replies first seen by this server since start and not yet acknowledged.
   * Drives the web bell/toast; sticky so a tab that was closed when the reply
   * landed still sees it. The tray ignores this and dedups `replies` itself.
   */
  notifications: ReplyNotification[];
  messageIds: Record<string, string>;
  receivedInboxes: Record<string, string>;
  /** Inboxes the last cycle could not read. Empty on a clean scan. A cycle can
   *  be ok and still be partially blind, so this is deliberately separate from
   *  lastError — it must not make the UI shout "sync failed". */
  inboxErrors: InboxScanError[];
  checked: number;
  updated: number;
  lastSyncAt: string | null;
  lastError: string;
  syncing: boolean;
};

type LoopState = {
  started: boolean;
  gen: number;
  /** Bumped whenever OAuth credentials or their recorded errors change OUTSIDE
   *  a scan cycle (manual recheck, token saved/cleared). A cycle that was
   *  already in flight across such a bump computed its inboxErrors with the old
   *  credentials, so it must not publish them over the fresher state. */
  authGen: number;
  busy: boolean;
  backoffMs: number;
  snapshot: ReplySyncSnapshot;
  /** Message ids already alerted on, so a reply notifies once per server run. */
  seen: Set<string>;
  /** False until the first cycle completes; see the alert logic in the cycle. */
  seeded: boolean;
  /** Resolves when the in-flight cycle finishes; lets callers await a trigger. */
  inflight: Promise<void> | null;
};

const emptySnapshot: ReplySyncSnapshot = {
  configured: false,
  replies: [],
  notifications: [],
  messageIds: {},
  receivedInboxes: {},
  inboxErrors: [],
  checked: 0,
  updated: 0,
  lastSyncAt: null,
  lastError: "",
  syncing: false,
};

const globalForLoop = globalThis as unknown as { __replySyncLoop?: LoopState };
const state: LoopState = globalForLoop.__replySyncLoop ?? {
  started: false,
  gen: 0,
  authGen: 0,
  busy: false,
  backoffMs: 0,
  snapshot: { ...emptySnapshot },
  seen: new Set<string>(),
  seeded: false,
  inflight: null,
};
globalForLoop.__replySyncLoop = state;

// Allow a re-executed module to arm a fresh loop (see startReplySyncLoop for
// where the generation is actually bumped).
state.started = false;
// A state object persisted by an older module instance predates authGen.
state.authGen = Number.isFinite(state.authGen) ? state.authGen : 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Keyed by contact, not sheet row: rows that were never reconciled to a sheet
// all carry row 0, so a row-keyed set would treat every one of them as the
// same alert.
function alertKey(reply: ReplyNotification): string {
  return `${reply.contact}:${reply.messageId}`;
}

/** Run one sync cycle. Never throws; failures land in the snapshot. */
export async function runReplySyncNow(): Promise<ReplySyncSnapshot> {
  // Collapse concurrent callers (loop tick + a client trigger) onto one run.
  if (state.inflight) {
    await state.inflight;
    return state.snapshot;
  }

  if (!isGmailReplySyncConfigured()) {
    // Keep un-acked alerts. Credentials can go missing for a cycle or two while
    // an account is being reconnected in the Accounts modal, and dropping them
    // here would lose them for good: `seen` still holds their keys, so the next
    // successful cycle would not re-raise them.
    state.snapshot = {
      ...emptySnapshot,
      lastSyncAt: state.snapshot.lastSyncAt,
      notifications: state.snapshot.notifications,
    };
    return state.snapshot;
  }

  state.busy = true;
  state.snapshot = { ...state.snapshot, syncing: true };

  const run = (async () => {
    // Credentials as of when this cycle started. If they change mid-flight
    // (manual recheck, token saved/cleared bumps authGen), the errors this
    // cycle computed describe the OLD credentials — keep the snapshot's
    // fresher ones instead of landing stale state on top of them.
    const authGenAtStart = state.authGen;
    const cycleInboxErrors = (fresh: InboxScanError[]): InboxScanError[] =>
      state.authGen === authGenAtStart ? fresh : state.snapshot.inboxErrors;

    try {
      const result: ReplySyncResult = await syncRepliesToSheet(
        loadPersistedMessageIds(),
      );

      if (!result.ok) {
        state.snapshot = {
          ...state.snapshot,
          syncing: false,
          inboxErrors: cycleInboxErrors(result.inboxErrors),
          lastError: result.error ?? "Reply sync failed.",
        };
        return;
      }

      if (Object.keys(result.messageIds).length > 0) {
        savePersistedMessageIds(result.messageIds);
      }

      // First cycle after a server start has an empty seen-set, so trusting it
      // alone would re-toast every reply on every restart. Fall back to the
      // persisted-id diff that syncRepliesToSheet computed (result.notifications)
      // for that one cycle; from then on the seen-set is authoritative, which
      // also covers rows that have no sheet row to key a persisted id by.
      const candidates = state.seeded ? result.replies : result.notifications;
      const fresh = candidates.filter((r) => !state.seen.has(alertKey(r)));
      for (const r of result.replies) state.seen.add(alertKey(r));
      state.seeded = true;

      // Accumulate rather than replace: a cycle that finds nothing new must not
      // discard alerts the web client hasn't shown yet. They clear on ack. The
      // tray never acks and doesn't need to - it reads `replies` and dedups
      // against its own on-disk seen-set, so the two clients can't starve each
      // other the way they did when both drove the shared persisted id map.
      const pending = [...state.snapshot.notifications];
      const pendingKeys = new Set(pending.map(alertKey));
      for (const r of fresh) {
        if (!pendingKeys.has(alertKey(r))) pending.push(r);
      }

      state.snapshot = {
        configured: true,
        replies: result.replies,
        notifications: pending,
        messageIds: result.messageIds,
        receivedInboxes: result.receivedInboxes,
        inboxErrors: cycleInboxErrors(result.inboxErrors),
        checked: result.checked,
        updated: result.updated,
        lastSyncAt: new Date().toISOString(),
        lastError: "",
        syncing: false,
      };
    } catch (err) {
      state.snapshot = {
        ...state.snapshot,
        syncing: false,
        lastError: err instanceof Error ? err.message : String(err),
      };
    } finally {
      state.busy = false;
    }
  })();

  state.inflight = run;
  try {
    await run;
  } finally {
    state.inflight = null;
  }
  return state.snapshot;
}

/** Re-verify reply-sync auth for every connected inbox and publish the result
 *  into the snapshot the UI reads (Accounts → "Recheck all", saving the shared
 *  OAuth client), instead of waiting up to a full backoff interval for the next
 *  loop cycle. Only the auth stage was re-tested, so read-stage errors survive
 *  for inboxes that pass — a full cycle is what clears those. Returns the
 *  errors as published, read-stage carryovers included. */
export async function recheckInboxAuthNow(): Promise<{
  checked: number;
  errors: InboxScanError[];
}> {
  // Cached access tokens can outlive the credentials that minted them by up to
  // an hour; drop them so the next cycle runs on what is stored NOW.
  clearGmailTokenCache();
  const fresh = await verifyReplySyncAuth();
  const failing = new Set(fresh.errors.map((e) => e.inbox));
  const errors = [
    ...fresh.errors,
    ...state.snapshot.inboxErrors.filter(
      (e) => e.stage === "read" && !failing.has(e.inbox),
    ),
  ];
  state.authGen++;
  state.snapshot = { ...state.snapshot, inboxErrors: errors };
  return { checked: fresh.checked, errors };
}

/** Forget one inbox's reply-sync auth state — cached access token and recorded
 *  error — after its refresh token was replaced (it just verified), cleared
 *  (sync off must not keep showing "broken"), or its Sender was removed. */
export function forgetInboxAuth(inbox: string): void {
  const key = inbox.trim().toLowerCase();
  clearGmailTokenCache(key);
  state.authGen++;
  state.snapshot = {
    ...state.snapshot,
    inboxErrors: state.snapshot.inboxErrors.filter((e) => e.inbox !== key),
  };
}

/** Latest cached result. Cheap - safe to call per request. */
export function getReplySyncSnapshot(): ReplySyncSnapshot {
  return {
    ...state.snapshot,
    configured: isGmailReplySyncConfigured(),
    syncing: state.busy,
  };
}

/**
 * Mark alerts as consumed so they stop being reported as new. Clients call this
 * after showing them; the reply itself stays in `replies`.
 */
export function ackReplyNotifications(keys: string[]): void {
  if (keys.length === 0) return;
  const acked = new Set(keys);
  state.snapshot = {
    ...state.snapshot,
    notifications: state.snapshot.notifications.filter(
      (n) => !acked.has(alertKey(n)),
    ),
  };
}

async function loop(myGen: number): Promise<void> {
  // Let the server settle before the first Gmail round-trip.
  await sleep(FIRST_RUN_DELAY_MS);
  for (;;) {
    if (state.gen !== myGen) return;
    await runReplySyncNow();
    state.backoffMs = state.snapshot.lastError
      ? Math.min(MAX_BACKOFF_MS, Math.max(SYNC_MS, state.backoffMs * 2))
      : 0;
    await sleep(state.backoffMs || SYNC_MS);
  }
}

export function startReplySyncLoop(): void {
  if (state.started) return;
  state.started = true;

  // Bumped HERE rather than at module scope, so that only ARMING a new loop
  // retires the old one. The route handlers import this module too, and a
  // production build instantiates it a second time inside the route bundle -
  // a module-scope bump meant the first request to touch /api/sync-replies
  // silently retired the running loop, which then never synced at all.
  state.gen = (Number.isFinite(state.gen) ? state.gen : 0) + 1;
  const myGen = state.gen;

  if (!isGmailReplySyncConfigured()) {
    // Not fatal: the loop still ticks and picks up credentials as soon as an
    // account is connected through the Accounts modal, with no restart.
    console.log("[reply-sync] loop idle - no Gmail account connected");
  } else {
    console.log(`[reply-sync] loop armed (${Math.round(SYNC_MS / 1000)}s)`);
  }
  void loop(myGen);
}
