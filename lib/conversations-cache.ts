// SQLite cache for Gmail thread conversations, keyed by the client's
// threadKey. Makes the replies panel open instantly: cached threads are
// served from the database while a background refresh fetches the live
// thread from Gmail and updates the cache for the next poll.

import { db } from "./db";
import {
  getThreadConversation,
  listPreviewFromConversation,
  type GmailThreadConversation,
  type ReplyListPreview,
} from "./gmail";

export type ConversationPayload = {
  thread: GmailThreadConversation;
  preview: ReplyListPreview;
};

// Refresh a cached thread at most this often - matches the UI poll cadence
// closely enough that new messages appear within a poll or two.
const REVALIDATE_AFTER_MS = 30_000;

// One background refresh per thread at a time.
const refreshing = new Set<string>();

export function getCachedConversation(
  threadKey: string,
): { payload: ConversationPayload; ageMs: number } | null {
  try {
    const row = db
      .prepare(
        `SELECT payload, updated_at FROM conversations WHERE thread_key = ?`,
      )
      .get(threadKey) as { payload: string; updated_at: string } | undefined;
    if (!row) return null;
    const payload = JSON.parse(row.payload) as ConversationPayload;
    const ageMs = Date.now() - new Date(row.updated_at).getTime();
    return { payload, ageMs };
  } catch {
    return null;
  }
}

function storeConversation(
  threadKey: string,
  payload: ConversationPayload,
): void {
  try {
    db.prepare(
      `INSERT INTO conversations (thread_key, payload, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(thread_key) DO UPDATE SET
         payload = excluded.payload, updated_at = excluded.updated_at`,
    ).run(threadKey, JSON.stringify(payload), new Date().toISOString());
  } catch {
    // Cache is best-effort; live serving still works.
  }
}

/** Fetch the thread live from Gmail and update the cache. */
export async function fetchAndCacheConversation(item: {
  threadKey: string;
  sender: string;
  contact: string;
  after?: string;
}): Promise<ConversationPayload | null> {
  const thread = await getThreadConversation(
    item.sender.trim(),
    item.contact.trim().toLowerCase(),
    item.after?.trim() ?? "",
  );
  if (!thread) return null;
  const payload: ConversationPayload = {
    thread,
    preview: listPreviewFromConversation(thread),
  };
  storeConversation(item.threadKey, payload);
  return payload;
}

/** Kick off a background refresh unless one is already running or the cached
 *  copy is fresh enough. Never throws; result lands in the cache. */
export function revalidateInBackground(
  item: {
    threadKey: string;
    sender: string;
    contact: string;
    after?: string;
  },
  ageMs: number,
): void {
  if (ageMs < REVALIDATE_AFTER_MS) return;
  if (refreshing.has(item.threadKey)) return;
  refreshing.add(item.threadKey);
  void fetchAndCacheConversation(item)
    .catch(() => {})
    .finally(() => refreshing.delete(item.threadKey));
}
