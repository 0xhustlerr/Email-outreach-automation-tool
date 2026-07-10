/** One Gmail reply detected for a sheet row (any new message, not only the first). */
export type ReplyNotification = {
  _row: number;
  messageId: string;
  contact: string;
  name: string;
  /** Sheet send-from address (original outreach). */
  sender: string;
  /** Inbox where this reply was detected (may differ from sender). */
  receivedInbox: string;
  /** True when receivedInbox !== sender. */
  crossInbox: boolean;
  site: string;
  snippet: string;
  subject: string;
  /** True when this sync also set Active=yes on the sheet for the first time. */
  firstSheetUpdate: boolean;
};

export type ReplySyncResult = {
  ok: boolean;
  configured: boolean;
  checked: number;
  /** Rows where Active was set to yes for the first time only. */
  updated: number;
  /** Rows with a new Gmail message since lastMessageIds (for bell alerts). */
  notifications: ReplyNotification[];
  /**
   * Every row that currently has a reply, regardless of newness. Lets a client
   * (e.g. the tray) dedup against its own seen-set instead of the shared
   * server-persisted ids, so two clients don't starve each other's alerts.
   */
  replies: ReplyNotification[];
  /** Latest Gmail message id per sheet row checked (client should persist). */
  messageIds: Record<string, string>;
  /** Inbox that holds the latest reply, per sheet row. */
  receivedInboxes: Record<string, string>;
  error?: string;
};
