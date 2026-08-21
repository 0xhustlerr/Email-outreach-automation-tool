"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InboxScanError, ReplyNotification } from "@/lib/reply-alerts";
import type { SheetHistoryRow } from "@/lib/sheets";

const STALE_MS = 60_000;

const POLL_INTERVAL_MS = Math.max(
  20_000,
  Number(process.env.NEXT_PUBLIC_INBOX_POLL_MS ?? "45000") || 45_000,
);

const RECEIVED_INBOX_KEY = "email-finder-received-inbox-by-row";

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
  const [replies, setReplies] = useState<ReplyNotification[]>([]);
  const [messageIds, setMessageIds] = useState<Record<string, string>>({});
  // Inboxes the last sync cycle could not read. A partial failure still returns
  // ok, so without this the bell shows "all caught up" while replies to those
  // accounts are simply never looked at.
  const [inboxErrors, setInboxErrors] = useState<InboxScanError[]>([]);
  const [receivedInboxes, setReceivedInboxes] = useState<Record<string, string>>(
    () => ({}),
  );
  const lastFetchedRef = useRef(0);
  const inflightRef = useRef<Promise<void> | null>(null);
  const readyRef = useRef(false);
  const receivedInboxRef = useRef<Record<string, string>>({});
  const pendingAckRef = useRef<string[]>([]);

  useEffect(() => {
    receivedInboxRef.current = loadReceivedInboxes();
    setReceivedInboxes(receivedInboxRef.current);
  }, []);

  // Reads the background loop's cached result. `force` asks the server to run a
  // cycle now (the Refresh button) - the loop collapses that onto any scan
  // already in flight, so it can't stack up Gmail work.
  const runReplySync = useCallback(async (force = false) => {
    if (force) setSyncingReplies(true);
    try {
      const res = await fetch("/api/sync-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          force,
          // Alerts shown on the previous poll: tell the server to stop
          // reporting them as new, so a second poll inside one sync cycle
          // doesn't re-toast the same reply.
          ack: pendingAckRef.current,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        replies?: ReplyNotification[];
        notifications?: ReplyNotification[];
        messageIds?: Record<string, string>;
        receivedInboxes?: Record<string, string>;
        inboxErrors?: InboxScanError[];
      };
      if (res.ok && data.ok) {
        setInboxErrors(data.inboxErrors ?? []);
        if (data.messageIds) setMessageIds(data.messageIds);
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
        // Full set for Insights (sentiment needs every reply, not the delta);
        // the delta alone drives the bell.
        setReplies(data.replies ?? []);
        const fresh = data.notifications ?? [];
        // Must match alertKey() in lib/reply-sync-loop.ts.
        pendingAckRef.current = fresh.map((n) => `${n.contact}:${n.messageId}`);
        if (fresh.length > 0) setReplyNotifications(fresh);
      }
    } catch {
      // Best-effort.
    } finally {
      if (force) setSyncingReplies(false);
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
      setReplies([]);
      setMessageIds({});
      setReceivedInboxes({});
      lastFetchedRef.current = 0;
      pendingAckRef.current = [];
      return;
    }
    // Not forced: the background loop keeps the snapshot fresh, so opening a
    // tab now costs a cached read instead of kicking off an inbox scan.
    void load(false);
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
    replies,
    messageIds,
    receivedInboxes,
    inboxErrors,
    refresh: async () => {
      await load(readyRef.current, { forceSync: true });
    },
    refreshIfStale,
  };
}
