"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplyNotification } from "@/lib/reply-alerts";
import type {
  GmailThreadConversation,
  ReplyListPreview,
} from "@/lib/gmail";
import type { SheetHistoryRow } from "@/lib/sheets";
import type { ReplyFilterSelection } from "@/hooks/useNewReplies";
import { primaryEmail, replyInboxContext, replyThreadKey } from "@/lib/sheet-active";

type ConversationPayload = {
  thread: GmailThreadConversation;
  preview: ReplyListPreview;
};

type ConversationMap = Record<string, ConversationPayload | null>;

type AlertRow = SheetHistoryRow & { _alert?: ReplyNotification };

function rowToItem(
  row: AlertRow,
  receivedInboxByRow: Record<string, string>,
) {
  const ctx = replyInboxContext(row, row._alert, receivedInboxByRow);
  return {
    threadKey: replyThreadKey(row, ctx),
    sender: ctx.receivedInbox,
    contact: primaryEmail(row.contact),
    after: row.date,
  };
}

export function useReplyConversations(
  displayRows: AlertRow[],
  open: boolean,
  filter: ReplyFilterSelection,
  receivedInboxByRow: Record<string, string>,
) {
  const [conversations, setConversations] = useState<ConversationMap>({});
  const [loading, setLoading] = useState(false);
  const cacheRef = useRef<ConversationMap>({});
  const reqIdRef = useRef(0);

  const applyConversations = useCallback((patch: ConversationMap) => {
    const next = { ...cacheRef.current, ...patch };
    cacheRef.current = next;
    setConversations({ ...next });
  }, []);

  const threadKeyFor = useCallback(
    (row: AlertRow) =>
      replyThreadKey(
        row,
        replyInboxContext(row, row._alert, receivedInboxByRow),
      ),
    [receivedInboxByRow],
  );

  const fetchConversations = useCallback(
    async (rows: AlertRow[], force: boolean) => {
      if (rows.length === 0) return;

      const items = rows.map((row) => rowToItem(row, receivedInboxByRow));
      const missing = force
        ? items
        : items.filter((i) => cacheRef.current[i.threadKey] === undefined);

      if (missing.length === 0) return;

      const reqId = ++reqIdRef.current;
      setLoading(true);
      try {
        const res = await fetch("/api/gmail-conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: missing }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          conversations?: ConversationMap;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          throw new Error(data.error ?? "Failed to load conversations.");
        }
        if (reqId !== reqIdRef.current) return;
        applyConversations(data.conversations ?? {});
      } catch {
        if (reqId !== reqIdRef.current) return;
        const patch: ConversationMap = {};
        for (const item of missing) {
          if (cacheRef.current[item.threadKey] === undefined) {
            patch[item.threadKey] = null;
          }
        }
        applyConversations(patch);
      } finally {
        if (reqId === reqIdRef.current) setLoading(false);
      }
    },
    [applyConversations, receivedInboxByRow],
  );

  const loadOne = useCallback(
    async (
      row: AlertRow,
      force = false,
    ): Promise<ConversationPayload | null> => {
      const key = threadKeyFor(row);
      if (!force && cacheRef.current[key]) {
        return cacheRef.current[key];
      }

      const res = await fetch("/api/gmail-conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [rowToItem(row, receivedInboxByRow)],
          // force = caller must see the live thread (e.g. right after
          // sending a reply) - bypass the server's cache for this one.
          fresh: force,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        conversations?: ConversationMap;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to load conversation.");
      }
      const conv = data.conversations?.[key] ?? null;
      applyConversations({ [key]: conv });
      return conv;
    },
    [applyConversations, receivedInboxByRow, threadKeyFor],
  );

  /** Prefetch threads when panel is open (previews + message counts on list rows). */
  useEffect(() => {
    if (!open || displayRows.length === 0) return;
    void fetchConversations(displayRows, false);
  }, [open, displayRows, fetchConversations]);

  // On open: refetch everything. The server answers from its database cache
  // instantly and revalidates stale threads against Gmail in the background -
  // so follow up once shortly after to pick up whatever got refreshed.
  useEffect(() => {
    if (!open || displayRows.length === 0) return;
    void fetchConversations(displayRows, true);
    const timer = window.setTimeout(() => {
      void fetchConversations(displayRows, true);
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [open, displayRows, fetchConversations]);

  const getConversation = useCallback(
    (row: AlertRow) => conversations[threadKeyFor(row)] ?? undefined,
    [conversations, threadKeyFor],
  );

  const getPreview = useCallback(
    (row: AlertRow) => getConversation(row)?.preview,
    [getConversation],
  );

  /** Total messages in thread (yours + theirs). */
  const getMessageCount = useCallback(
    (row: AlertRow): number | null => {
      const conv = getConversation(row);
      if (conv === undefined) return null;
      if (!conv?.thread?.messages) return 0;
      return conv.thread.messages.length;
    },
    [getConversation],
  );

  return {
    getConversation,
    getPreview,
    getMessageCount,
    loadConversation: loadOne,
    loadingConversations: loading,
    threadKeyFor,
  };
}
