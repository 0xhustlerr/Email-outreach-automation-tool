"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplyNotification } from "@/lib/reply-alerts";
import type { SheetHistoryRow } from "@/lib/sheets";

const STALE_MS = 60_000;

const REPLY_SYNC_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.NEXT_PUBLIC_REPLY_SYNC_MS ?? "60000") || 60_000,
);

const POLL_INTERVAL_MS = Math.max(
  20_000,
  Number(process.env.NEXT_PUBLIC_INBOX_POLL_MS ?? "45000") || 45_000,
);

const KNOWN_MSG_IDS_KEY = "email-finder-known-gmail-msg-ids";
const RECEIVED_INBOX_KEY = "email-finder-received-inbox-by-row";

function loadKnownMessageIds(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KNOWN_MSG_IDS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function loadReceivedInboxes(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(RECEIVED_INBOX_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function useSheetHistory(enabled: boolean) {
  const [rows, setRows] = useState<SheetHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncingReplies, setSyncingReplies] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [replyNotifications, setReplyNotifications] = useState<
    ReplyNotification[]
  >([]);
  const [messageIds, setMessageIds] = useState<Record<string, string>>({});
  const [receivedInboxes, setReceivedInboxes] = useState<Record<string, string>>(
    () => ({}),
  );
  const lastFetchedRef = useRef(0);
  const lastReplySyncRef = useRef(0);
  const inflightRef = useRef<Promise<void> | null>(null);
  const readyRef = useRef(false);
  const knownIdsRef = useRef<Record<string, string>>({});
  const receivedInboxRef = useRef<Record<string, string>>({});

  useEffect(() => {
    knownIdsRef.current = loadKnownMessageIds();
    receivedInboxRef.current = loadReceivedInboxes();
    setReceivedInboxes(receivedInboxRef.current);
  }, []);

  const runReplySync = useCallback(async (force = false) => {
    if (
      !force &&
      Date.now() - lastReplySyncRef.current < REPLY_SYNC_INTERVAL_MS
    ) {
      return;
    }
    setSyncingReplies(true);
    try {
      const res = await fetch("/api/sync-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lastMessageIds: knownIdsRef.current,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        notifications?: ReplyNotification[];
        messageIds?: Record<string, string>;
        receivedInboxes?: Record<string, string>;
      };
      if (res.ok && data.ok) {
        if (data.messageIds) {
          knownIdsRef.current = data.messageIds;
          setMessageIds(data.messageIds);
          localStorage.setItem(
            KNOWN_MSG_IDS_KEY,
            JSON.stringify(data.messageIds),
          );
        }
        if (data.receivedInboxes) {
          receivedInboxRef.current = {
            ...receivedInboxRef.current,
            ...data.receivedInboxes,
          };
          setReceivedInboxes({ ...receivedInboxRef.current });
          localStorage.setItem(
            RECEIVED_INBOX_KEY,
            JSON.stringify(receivedInboxRef.current),
          );
        }
        setReplyNotifications(data.notifications ?? []);
      }
      lastReplySyncRef.current = Date.now();
    } catch {
      // Best-effort.
    } finally {
      setSyncingReplies(false);
    }
  }, []);

  const load = useCallback(
    async (silent = false, options?: { forceSync?: boolean }) => {
      if (!enabled) return;

      if (inflightRef.current) {
        await inflightRef.current;
        return;
      }

      const showSpinner = !silent || !readyRef.current;
      if (showSpinner) setLoading(true);

      const run = (async () => {
        setError(null);
        try {
          await runReplySync(options?.forceSync ?? false);

          const res = await fetch("/api/sheet-history");
          const data = (await res.json()) as {
            ok?: boolean;
            rows?: SheetHistoryRow[];
            error?: string;
          };
          if (!res.ok || !data.ok) {
            throw new Error(
              data.error ?? `Failed to load history (${res.status}).`,
            );
          }
          setRows(data.rows ?? []);
          lastFetchedRef.current = Date.now();
          readyRef.current = true;
          setReady(true);
        } catch (err) {
          setError(
            err instanceof Error ? err.message : "Failed to load sheet history.",
          );
        } finally {
          if (showSpinner) setLoading(false);
        }
      })();

      inflightRef.current = run;
      try {
        await run;
      } finally {
        inflightRef.current = null;
      }
    },
    [enabled, runReplySync],
  );

  const poll = useCallback(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    if (!enabled) {
      setRows([]);
      setReady(false);
      readyRef.current = false;
      setError(null);
      setLoading(false);
      setSyncingReplies(false);
      setReplyNotifications([]);
      setMessageIds({});
      setReceivedInboxes({});
      lastFetchedRef.current = 0;
      lastReplySyncRef.current = 0;
      return;
    }
    void load(false, { forceSync: true });
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, poll]);

  useEffect(() => {
    if (!enabled) return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      lastReplySyncRef.current = 0;
      poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [enabled, poll]);

  const refreshIfStale = useCallback(() => {
    if (!enabled || !readyRef.current) return;
    if (Date.now() - lastFetchedRef.current >= STALE_MS) {
      void load(true);
    }
  }, [enabled, load]);

  return {
    rows,
    loading,
    syncingReplies,
    error,
    ready,
    replyNotifications,
    messageIds,
    receivedInboxes,
    refresh: async () => {
      lastReplySyncRef.current = 0;
      await load(readyRef.current, { forceSync: true });
    },
    refreshIfStale,
  };
}
