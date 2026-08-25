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

/** One connected inbox that could not be read on the last scan.
 *
 *  A cycle where SOME inboxes fail still returns ok — the rows it could match
 *  are matched — so this is the only record that the scan was partially blind.
 *  Without it a dead refresh token on 2 of 3 accounts looks identical to "no
 *  replies": ok, no error, and a UI saying you're all caught up. */
export type InboxScanError = {
  /** The inbox that failed, lowercased. */
  inbox: string;
  /** Why, verbatim from Google where possible (e.g. "unauthorized_client"). */
  error: string;
  /** True when the refresh token itself was rejected — the account has to be
   *  reconnected, and no amount of retrying will fix it. */
  needsReauth: boolean;
  /** Which half of the scan failed: exchanging the refresh token ("auth") or
   *  reading the inbox after auth succeeded ("read"). Lets a manual auth-only
   *  recheck replace exactly the errors it re-tested and no others. */
  stage: "auth" | "read";
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
  /** Inboxes that could not be read this cycle. Empty on a clean scan. */
  inboxErrors: InboxScanError[];
  error?: string;
};
