import { NextResponse } from "next/server";
import { markUserActivity } from "@/lib/avatar-prefetch";
import { isGmailReplySyncConfigured } from "@/lib/gmail";
import {
  fetchAndCacheConversation,
  getCachedConversation,
  revalidateInBackground,
  type ConversationPayload,
} from "@/lib/conversations-cache";
import { attachOpenReceipts } from "@/lib/open-receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ITEMS = 30;
const CONCURRENCY = 4;

type ConversationRequestItem = {
  threadKey: string;
  sender: string;
  contact: string;
  after?: string;
};

export type { ConversationPayload };

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

export async function POST(req: Request) {
  if (!isGmailReplySyncConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Gmail reply sync is not configured." },
      { status: 503 },
    );
  }

  let body: { items?: ConversationRequestItem[]; fresh?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const items = (body.items ?? []).slice(0, MAX_ITEMS).filter(
    (i) =>
      i?.threadKey &&
      i.sender?.trim() &&
      i.contact?.trim() &&
      i.contact.includes("@"),
  );

  if (items.length === 0) {
    return NextResponse.json({ ok: true, conversations: {} });
  }

  try {
    // Stale-while-revalidate: anything cached in the database is returned
    // immediately (this is what makes the replies panel open instantly);
    // stale entries refresh in the background and land on the next poll.
    // Only never-seen threads block on a live Gmail fetch.
    const conversations: Record<string, ConversationPayload | null> = {};
    const misses: ConversationRequestItem[] = [];

    for (const item of items) {
      // fresh: caller needs live data NOW (e.g. just sent a reply and wants
      // the thread including it) - skip the cache read, fetch and re-cache.
      const cached = body.fresh ? null : getCachedConversation(item.threadKey);
      if (cached) {
        conversations[item.threadKey] = cached.payload;
        revalidateInBackground(item, cached.ageMs);
      } else {
        misses.push(item);
      }
    }

    if (misses.length > 0) {
      const results = await mapPool(misses, CONCURRENCY, async (item) => {
        try {
          return {
            threadKey: item.threadKey,
            conversation: await fetchAndCacheConversation(item),
          };
        } catch {
          return { threadKey: item.threadKey, conversation: null };
        }
      });
      for (const r of results) conversations[r.threadKey] = r.conversation;
    }

    // Attach open receipts at response time (not cache time) so opens that
    // arrive after a thread was cached still show on the next poll.
    for (const item of items) {
      const payload = conversations[item.threadKey];
      if (payload?.thread?.messages) {
        attachOpenReceipts(payload.thread.messages, item.contact);
      }
    }

    return NextResponse.json({ ok: true, conversations });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "Failed to load conversations.";
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
