import type { ReplyNotification } from "@/lib/reply-alerts";
import type { SheetHistoryRow } from "@/lib/sheets";
import { primaryEmail, rowKey } from "@/lib/sheet-active";

export type ReplyInboxContext = {
  /** Address used for original outreach (sheet column). */
  sentFrom: string;
  /** Inbox where the latest reply was found. */
  receivedInbox: string;
  /** Reply landed in a different inbox than the send-from address. */
  crossInbox: boolean;
};

export function replyInboxContext(
  row: SheetHistoryRow,
  alert?: ReplyNotification | null,
  receivedInboxByRow?: Record<string, string>,
): ReplyInboxContext {
  const sentFrom = row.sender.trim().toLowerCase();
  const rk = rowKey(row);
  const fromMap =
    rk != null ? receivedInboxByRow?.[String(rk)]?.trim().toLowerCase() : "";
  const receivedInbox = (
    alert?.receivedInbox?.trim().toLowerCase() ||
    fromMap ||
    sentFrom
  ).trim();

  return {
    sentFrom,
    receivedInbox: receivedInbox || sentFrom,
    crossInbox: !!receivedInbox && receivedInbox !== sentFrom,
  };
}

/** Thread id for UI + Gmail: contact + inbox that holds the conversation. */
export function replyThreadKey(
  row: SheetHistoryRow,
  ctx?: ReplyInboxContext | null,
  alert?: ReplyNotification | null,
  receivedInboxByRow?: Record<string, string>,
): string {
  const inbox =
    ctx?.receivedInbox ??
    replyInboxContext(row, alert, receivedInboxByRow).receivedInbox;
  return `${primaryEmail(row.contact)}|${inbox}`;
}

export function inboxContextLabel(ctx: ReplyInboxContext): string {
  if (ctx.crossInbox) {
    return `Replied to ${ctx.receivedInbox} · you sent from ${ctx.sentFrom}`;
  }
  return ctx.receivedInbox;
}

export function notificationTitle(
  name: string,
  ctx: ReplyInboxContext,
  isNewMessage: boolean,
): string {
  if (ctx.crossInbox) {
    return isNewMessage
      ? `Reply on another inbox - ${name}`
      : `Reply on another inbox - ${name}`;
  }
  return isNewMessage ? `New message from ${name}` : `Reply from ${name}`;
}
