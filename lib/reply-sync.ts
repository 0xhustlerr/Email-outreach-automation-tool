import {
  getRecentInboundByContact,
  isGmailReplySyncConfigured,
  type InboundReply,
} from "@/lib/gmail";
import { notifyNewReply } from "@/lib/knock-server";
import type { ReplyNotification, ReplySyncResult } from "@/lib/reply-alerts";
import {
  batchUpdateSheetRows,
  fetchSheetHistory,
  type SheetHistoryRow,
} from "@/lib/sheets";
import { markRepliedInDb } from "@/lib/db";

function primaryEmail(contact: string): string {
  const part = contact.split(/[/,;]/)[0]?.trim() ?? "";
  const match = part.match(/[^\s@]+@[^\s@]+\.[^\s@]+/i);
  return match ? match[0].toLowerCase() : part.toLowerCase();
}

function isYes(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "yes" || v === "y" || v === "true" || v === "1";
}

function parseRowDateMs(iso: string): number | null {
  if (!iso.trim()) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

export type { ReplyNotification, ReplySyncResult };

export async function syncRepliesToSheet(
  lastMessageIds: Record<string, string> = {},
): Promise<ReplySyncResult> {
  if (!isGmailReplySyncConfigured()) {
    return {
      ok: true,
      configured: false,
      checked: 0,
      updated: 0,
      notifications: [],
      replies: [],
      messageIds: {},
      receivedInboxes: {},
    };
  }

  let rows: SheetHistoryRow[];
  try {
    rows = await fetchSheetHistory();
  } catch (err) {
    return {
      ok: false,
      configured: true,
      checked: 0,
      updated: 0,
      notifications: [],
      replies: [],
      messageIds: {},
      receivedInboxes: {},
      error: err instanceof Error ? err.message : "Failed to load sheet.",
    };
  }

  // How far back to look for replies, and how many recent inbound messages to
  // scan per inbox. Scanning the inbox (not each sent row) means replies are
  // found no matter how many newer emails were sent since the outreach.
  const replyWindowDays = Math.min(
    120,
    Math.max(3, Number(process.env.GMAIL_REPLY_WINDOW_DAYS ?? "30") || 30),
  );
  const inboxScanCap = Math.min(
    2000,
    Math.max(50, Number(process.env.GMAIL_INBOX_SCAN_CAP ?? "400") || 400),
  );

  let inboundByContact: Map<string, InboundReply>;
  try {
    inboundByContact = await getRecentInboundByContact(
      replyWindowDays,
      inboxScanCap,
    );
  } catch (err) {
    return {
      ok: false,
      configured: true,
      checked: 0,
      updated: 0,
      notifications: [],
      replies: [],
      messageIds: {},
      receivedInboxes: {},
      error: err instanceof Error ? err.message : "Failed to scan inboxes.",
    };
  }

  const updates: {
    _row: number;
    active?: string;
    replied?: string;
    repliedAt?: string;
  }[] = [];
  const notifications: ReplyNotification[] = [];
  const replies: ReplyNotification[] = [];
  const messageIds: Record<string, string> = { ...lastMessageIds };
  const receivedInboxes: Record<string, string> = {};

  let checked = 0;

  const rowByNum = new Map(rows.map((r) => [r._row, r]));

  // Only alert once per contact even when several sent rows share it.
  const alerted = new Set<string>();

  for (const row of rows) {
    const rowNum = row._row;
    if (!rowNum || rowNum < 2) continue;

    const sentFrom = row.sender.trim().toLowerCase();
    const contact = primaryEmail(row.contact);
    if (!sentFrom || !contact.includes("@")) continue;

    const inbound = inboundByContact.get(contact);
    if (!inbound) continue;

    // The inbound message must have arrived after we sent this row.
    const rowSentMs = parseRowDateMs(row.date);
    if (
      rowSentMs !== null &&
      inbound.receivedMs > 0 &&
      inbound.receivedMs <= rowSentMs
    ) {
      continue;
    }

    checked++;

    const latestId = inbound.id;
    const receivedInbox = inbound.inbox;
    const crossInbox = receivedInbox !== sentFrom;

    const rowKey = String(rowNum);
    const prevId = lastMessageIds[rowKey] ?? "";
    const isNewMessage = latestId !== prevId;

    messageIds[rowKey] = latestId;
    receivedInboxes[rowKey] = receivedInbox;

    const rowIsActive = isYes(row.active);

    // Self-heal: whenever a reply exists and the sheet isn't marked active,
    // set it - not only the first time the message id changes. This is what
    // keeps a replied row from being stuck on "No".
    if (!rowIsActive) {
      updates.push({ _row: rowNum, active: "yes", replied: "yes" });
      markRepliedInDb(
        contact,
        inbound.receivedMs > 0
          ? new Date(inbound.receivedMs).toISOString()
          : new Date().toISOString(),
      );
    }

    if (alerted.has(contact)) continue;
    alerted.add(contact);

    const name = (row.name ?? "").trim() || contact;
    const snippet = inbound.snippet?.slice(0, 200) || "";
    const subject = inbound.subject || "";

    // Full current reply set - the tray dedups against its own seen-set so it
    // isn't starved by the web page consuming the shared "new" flag first.
    replies.push({
      _row: rowNum,
      messageId: latestId,
      contact,
      name,
      sender: row.sender,
      receivedInbox,
      crossInbox,
      site: row.site ?? "",
      snippet,
      subject,
      firstSheetUpdate: false,
    });

    // Suppress the popup only for rows already marked active before we ever
    // tracked a message id (avoids re-alerting old, handled replies).
    if (isNewMessage && !(prevId === "" && rowIsActive)) {
      notifications.push({
        _row: rowNum,
        messageId: latestId,
        contact,
        name,
        sender: row.sender,
        receivedInbox,
        crossInbox,
        site: row.site ?? "",
        snippet,
        subject,
        firstSheetUpdate: !rowIsActive,
      });
    }
  }

  if (updates.length > 0) {
    try {
      await batchUpdateSheetRows(updates);
    } catch (err) {
      return {
        ok: false,
        configured: true,
        checked,
        updated: 0,
        notifications: [],
        replies,
        messageIds,
        receivedInboxes,
        error: err instanceof Error ? err.message : "Sheet update failed.",
      };
    }
  }

  for (const alert of notifications) {
    const row = rowByNum.get(alert._row);
    if (row) {
      await notifyNewReply(row, alert._row, alert.snippet || alert.subject);
    }
  }

  return {
    ok: true,
    configured: true,
    checked,
    updated: updates.length,
    notifications,
    replies,
    messageIds,
    receivedInboxes,
  };
}
