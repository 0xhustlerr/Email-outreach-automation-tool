"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReplyNotification } from "@/lib/reply-alerts";
import type { CustomReplyTab } from "@/lib/reply-custom-tabs";
import { threadKeyForRow } from "@/lib/reply-custom-tabs";
import type { SheetHistoryRow } from "@/lib/sheets";
import { isActiveRow, replyInboxContext, replyThreadKey, rowKey } from "@/lib/sheet-active";

const ACKED_MSG_IDS_KEY = "email-finder-acked-gmail-msg-ids";
const KNOWN_MSG_IDS_KEY = "email-finder-known-gmail-msg-ids";

function loadJsonRecord(key: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveJsonRecord(key: string, data: Record<string, string>) {
  localStorage.setItem(key, JSON.stringify(data));
}

export type ReplyFilterSelection =
  | { kind: "unread" }
  | { kind: "all" }
  | { kind: "custom"; tabId: string };

export type AlertRow = SheetHistoryRow & { _alert?: ReplyNotification };

function sortByRowDesc(a: SheetHistoryRow, b: SheetHistoryRow): number {
  return (rowKey(b) ?? 0) - (rowKey(a) ?? 0);
}

function latestRowPerThread(
  rows: AlertRow[],
  receivedInboxByRow: Record<string, string>,
): AlertRow[] {
  const byThread = new Map<string, AlertRow>();
  for (const row of rows) {
    const key = replyThreadKey(row, null, row._alert, receivedInboxByRow);
    const existing = byThread.get(key);
    if (!existing || (rowKey(row) ?? 0) > (rowKey(existing) ?? 0)) {
      byThread.set(key, row);
    }
  }
  return [...byThread.values()].sort(sortByRowDesc);
}

export function useNewReplies(
  rows: SheetHistoryRow[],
  syncNotifications: ReplyNotification[],
  messageIds: Record<string, string>,
  receivedInboxByRow: Record<string, string> = {},
  customTabs: CustomReplyTab[] = [],
) {
  const [ackedMessageIds, setAckedMessageIds] = useState<Record<string, string>>(
    () => ({}),
  );
  const [knownMessageIds, setKnownMessageIds] = useState<Record<string, string>>(
    () => ({}),
  );
  const [filter, setFilter] = useState<ReplyFilterSelection>({ kind: "unread" });

  useEffect(() => {
    setAckedMessageIds(loadJsonRecord(ACKED_MSG_IDS_KEY));
    setKnownMessageIds(loadJsonRecord(KNOWN_MSG_IDS_KEY));
  }, []);

  useEffect(() => {
    if (Object.keys(messageIds).length === 0) return;
    setKnownMessageIds((prev) => {
      const next = { ...prev, ...messageIds };
      saveJsonRecord(KNOWN_MSG_IDS_KEY, next);
      return next;
    });
  }, [messageIds]);

  const rowByNum = useMemo(() => {
    const m = new Map<number, SheetHistoryRow>();
    for (const row of rows) {
      const k = rowKey(row);
      if (k) m.set(k, row);
    }
    return m;
  }, [rows]);

  const alertByRow = useMemo(() => {
    const m = new Map<number, ReplyNotification>();
    for (const n of syncNotifications) m.set(n._row, n);
    return m;
  }, [syncNotifications]);

  const alertRows = useMemo((): AlertRow[] => {
    const withMsg: AlertRow[] = [];
    const seenRows = new Set<number>();

    for (const n of syncNotifications) {
      const sheet = rowByNum.get(n._row);
      if (sheet) {
        withMsg.push({ ...sheet, _alert: n });
        seenRows.add(n._row);
      }
    }

    for (const row of rows) {
      const k = rowKey(row);
      if (!k || seenRows.has(k)) continue;
      const msgId = knownMessageIds[String(k)];
      if (msgId) {
        withMsg.push({ ...row, _alert: alertByRow.get(k) });
      }
    }

    return withMsg.sort(sortByRowDesc);
  }, [rows, syncNotifications, rowByNum, knownMessageIds, alertByRow]);

  const activeSessions = useMemo(
    () =>
      latestRowPerThread(
        rows.filter(isActiveRow).map((row) => {
          const k = rowKey(row);
          return k
            ? { ...row, _alert: alertByRow.get(k) }
            : row;
        }),
        receivedInboxByRow,
      ),
    [rows, receivedInboxByRow, alertByRow],
  );

  const isUnread = useCallback(
    (row: SheetHistoryRow) => {
      const k = rowKey(row);
      if (!k) return false;
      const latest = knownMessageIds[String(k)];
      if (!latest) return false;
      return ackedMessageIds[String(k)] !== latest;
    },
    [knownMessageIds, ackedMessageIds],
  );

  const unseen = useMemo(
    () =>
      latestRowPerThread(
        alertRows.filter((row) => isUnread(row)),
        receivedInboxByRow,
      ),
    [alertRows, isUnread, receivedInboxByRow],
  );

  const unseenCount = unseen.length;
  const allCount = activeSessions.length;

  const customTabCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tab of customTabs) {
      const keys = new Set(tab.threadKeys);
      counts[tab.id] = activeSessions.filter((row) =>
        keys.has(threadKeyForRow(row, receivedInboxByRow)),
      ).length;
    }
    return counts;
  }, [customTabs, activeSessions, receivedInboxByRow]);

  const displayRows = useMemo((): AlertRow[] => {
    if (filter.kind === "unread") return unseen;
    if (filter.kind === "all") return activeSessions;
    const tab = customTabs.find((t) => t.id === filter.tabId);
    if (!tab) return [];
    const keys = new Set(tab.threadKeys);
    return activeSessions.filter((row) =>
      keys.has(threadKeyForRow(row, receivedInboxByRow)),
    );
  }, [filter, unseen, activeSessions, customTabs, receivedInboxByRow]);

  const markSeen = useCallback(
    (rowId: number) => {
      const latest = knownMessageIds[String(rowId)];
      if (!latest) return;
      setAckedMessageIds((prev) => {
        const next = { ...prev, [String(rowId)]: latest };
        saveJsonRecord(ACKED_MSG_IDS_KEY, next);
        return next;
      });
    },
    [knownMessageIds],
  );

  const markAllSeen = useCallback(() => {
    setAckedMessageIds((prev) => {
      const next = { ...prev, ...knownMessageIds };
      saveJsonRecord(ACKED_MSG_IDS_KEY, next);
      return next;
    });
  }, [knownMessageIds]);

  const inboxContextFor = useCallback(
    (row: AlertRow) => replyInboxContext(row, row._alert, receivedInboxByRow),
    [receivedInboxByRow],
  );

  return {
    alertRows,
    activeSessions,
    unseen,
    unseenCount,
    allCount,
    customTabCounts,
    displayRows,
    filter,
    setFilter,
    markSeen,
    markAllSeen,
    isUnread,
    inboxContextFor,
    receivedInboxByRow,
  };
}
