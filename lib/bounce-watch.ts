// Watches each connected Gmail inbox for delivery-status notifications and
// pauses a sending account for the day when one is a POLICY block.
//
// This is the primary detector: sending through smtp.gmail.com usually SUCCEEDS
// at the protocol level and Gmail bounces the message back minutes later, so
// the synchronous catch in send-core never sees it. Runs on its own loop rather
// than off /api/sync-replies, because the tray gates that call on Google Sheets
// being configured and bounce detection needs only Gmail OAuth.
//
// Needs no new OAuth scope: a DSN is an ordinary message in the account's own
// mailbox, which gmail.readonly already covers.

import { db } from "./db";
import {
  classifyBounceText,
  extractFailedRecipient,
  isDsnMessage,
  type BounceKind,
} from "./bounce-classify";
import {
  decodeBase64Url,
  getAccessToken,
  gmailFetch,
  headerValue,
  parseEmailFromHeader,
  parseGmailAccounts,
  parseReceivedAt,
  type GmailMessagePart,
} from "./gmail";
import { listIdentities } from "./mail";
import { localDayKey, pauseSender } from "./sender-blocks";

const SCAN_MS = 120_000;
const MAX_BACKOFF_MS = 900_000; // 15 min after repeated Gmail failures
// We only ever ACT on a bounce from the current local day; 2 days of overlap
// covers a restart and any timezone skew without re-reading a month of mail.
const SCAN_DAYS = 2;
const MAX_PER_INBOX = 60;
const PRUNE_DAYS = 45;

type WatchState = {
  started: boolean;
  gen: number;
  lastScanAt: string | null;
  lastError: string;
  backoffMs: number;
};

const globalForWatch = globalThis as unknown as { __bounceWatch?: WatchState };
const state: WatchState = globalForWatch.__bounceWatch ?? {
  started: false,
  gen: 0,
  lastScanAt: null,
  lastError: "",
  backoffMs: 0,
};
globalForWatch.__bounceWatch = state;

// Allow a re-executed module to arm a fresh watcher; the generation itself is
// bumped in startBounceWatch, NOT here. /api/queue imports scanBouncesNow, so a
// production build instantiates this module a second time inside that route's
// bundle - bumping at module scope meant the first request to the queue route
// retired the running watcher, silently ending bounce detection for the
// session (and with it the automatic stand-down of a blocked sender).
state.started = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// in:anywhere because bounces regularly land in spam, which the reply-sync
// scan deliberately excludes.
const BOUNCE_QUERY =
  `newer_than:${SCAN_DAYS}d in:anywhere ` +
  `(from:mailer-daemon OR from:postmaster OR ` +
  `subject:"Delivery Status Notification" OR ` +
  `subject:"Undelivered Mail Returned to Sender")`;

type ListResponse = {
  messages?: { id: string }[];
  error?: { message?: string };
};

type MessageResponse = {
  id?: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  error?: { message?: string };
};

async function listBounceIds(access: string): Promise<string[]> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", BOUNCE_QUERY);
  url.searchParams.set("maxResults", String(MAX_PER_INBOX));
  const res = await gmailFetch(url.toString(), {
    headers: { Authorization: `Bearer ${access}` },
  });
  const data = (await res.json()) as ListResponse;
  if (!res.ok) {
    throw new Error(data.error?.message ?? `Gmail list failed (${res.status}).`);
  }
  return (data.messages ?? []).map((m) => m.id);
}

async function fetchMessage(
  access: string,
  id: string,
): Promise<MessageResponse | null> {
  const res = await gmailFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${access}` } },
  );
  if (!res.ok) return null;
  return (await res.json()) as MessageResponse;
}

/**
 * Every readable scrap of a DSN.
 *
 * extractBodies() in gmail.ts is not enough here: it only decodes text/plain
 * and text/html, which skips the message/delivery-status part where the
 * enhanced status code and Diagnostic-Code actually live.
 */
function collectDsnText(part: GmailMessagePart, out: string[], depth = 0): void {
  if (depth > 8) return;
  const mime = (part.mimeType ?? "").toLowerCase();
  const data = part.body?.data;
  if (data && (mime.startsWith("text/") || mime === "message/delivery-status")) {
    try {
      out.push(decodeBase64Url(data));
    } catch {
      // undecodable part - ignore
    }
  }
  for (const p of part.parts ?? []) collectDsnText(p, out, depth + 1);
}

/** The original message's From:, from the rfc822 headers embedded in the DSN. */
function originalSender(part: GmailMessagePart, depth = 0): string {
  if (depth > 8) return "";
  const mime = (part.mimeType ?? "").toLowerCase();
  if (mime === "text/rfc822-headers" && part.body?.data) {
    try {
      const from = decodeBase64Url(part.body.data).match(/^from:\s*(.+)$/im);
      if (from) return parseEmailFromHeader(from[1]);
    } catch {
      // fall through
    }
  }
  if (mime === "message/rfc822") {
    for (const p of part.parts ?? []) {
      const from = headerValue(p.headers, "From");
      if (from) return parseEmailFromHeader(from);
    }
  }
  for (const p of part.parts ?? []) {
    const found = originalSender(p, depth + 1);
    if (found) return found;
  }
  return "";
}

/**
 * Which of OUR accounts sent the message that bounced.
 *
 * The inbox it was found in is normally right — sendMail authenticates to SMTP
 * as the identity itself, so the envelope sender is that account and Gmail
 * returns the DSN there. The embedded original From: is preferred when it names
 * a configured identity (it survives a mailbox forwarding rule); anything else
 * falls back to the inbox rather than trusting attacker-influenced text.
 */
function attributeSender(payload: GmailMessagePart | undefined, inbox: string): string {
  if (!payload) return inbox;
  const claimed = originalSender(payload);
  if (!claimed) return inbox;
  const configured = new Set(
    listIdentities().map((i) => i.email.toLowerCase()),
  );
  return configured.has(claimed) ? claimed : inbox;
}

const knownIdsStmt = () =>
  db.prepare(`SELECT gmail_id FROM bounce_events WHERE inbox = ?`);

const insertEventStmt = () =>
  db.prepare(
    `INSERT INTO bounce_events
       (inbox, gmail_id, sender, recipient, kind, status_code, detail,
        received_at, day_key, snippet, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(inbox, gmail_id) DO NOTHING`,
  );

async function scanInbox(inbox: string): Promise<string[]> {
  const access = await getAccessToken(inbox); // throws on a dead refresh token
  if (!access) return [];

  const ids = await listBounceIds(access);
  if (ids.length === 0) return [];

  // Skip ids we've already recorded WITHOUT fetching them. This is both the
  // dedup and the Gmail-quota saver: a steady state costs one list call.
  const known = new Set(
    (knownIdsStmt().all(inbox) as { gmail_id: string }[]).map((r) => r.gmail_id),
  );
  const fresh = ids.filter((id) => !known.has(id));
  if (fresh.length === 0) return [];

  const insert = insertEventStmt();
  const paused: string[] = [];
  const today = localDayKey();

  for (const id of fresh) {
    const msg = await fetchMessage(access, id);
    if (!msg?.payload) continue;

    const headers = msg.payload.headers;
    const from = parseEmailFromHeader(headerValue(headers, "From"));
    const subject = headerValue(headers, "Subject");
    const receivedAt = parseReceivedAt(
      headerValue(headers, "Date"),
      msg.internalDate,
    );
    const dayKey = receivedAt ? localDayKey(new Date(receivedAt)) : today;

    // Gmail's search is looser than our own DSN test (`from:postmaster` also
    // matches postmaster-noreply@…, which DSN_FROM_RE's ^postmaster@ anchor
    // rejects). Record the miss as 'other' anyway so it lands in the ledger and
    // is skipped by the id filter next cycle, instead of being re-fetched every
    // two minutes for the next two days.
    const isDsn = isDsnMessage(from, subject);

    const parts: string[] = [];
    if (isDsn) collectDsnText(msg.payload, parts);
    const body = isDsn ? [subject, msg.snippet ?? "", ...parts].join("\n") : "";

    const verdict = isDsn
      ? classifyBounceText(body)
      : { kind: "other" as const, statusCode: "", detail: "" };
    const sender = isDsn ? attributeSender(msg.payload, inbox) : inbox;

    // The insert comes BEFORE the pause decision and the decision is gated on
    // changes > 0, which is atomic in SQLite. That is what makes each DSN
    // evaluated for pausing exactly once ever - across restarts, across the
    // dev+tray double-process case, and after a manual resume (the id is in the
    // ledger by then, so the filter above never even re-fetches it).
    const res = insert.run(
      inbox,
      id,
      sender,
      extractFailedRecipient(body),
      verdict.kind satisfies BounceKind,
      verdict.statusCode,
      verdict.detail,
      receivedAt,
      dayKey,
      (msg.snippet ?? "").slice(0, 300),
      new Date().toISOString(),
    );
    if (res.changes === 0) continue;

    // Only today's policy blocks pause. A bounce that arrived at 23:58
    // yesterday must not pause us at 00:01 today.
    if (verdict.kind !== "policy" || dayKey !== today) continue;

    const created = pauseSender(sender, {
      reason: "Gmail blocked this account",
      detail: verdict.detail,
      statusCode: verdict.statusCode,
      source: "dsn",
      gmailId: id,
      recipient: extractFailedRecipient(body),
    });
    if (created) {
      paused.push(sender);
      console.warn(
        `[bounce] ${sender} policy-blocked by Gmail (${verdict.statusCode || "no code"}) — paused for today`,
      );
    }
  }

  return paused;
}

function prune(): void {
  try {
    const cutoff = new Date(Date.now() - PRUNE_DAYS * 86_400_000).toISOString();
    db.prepare(`DELETE FROM bounce_events WHERE seen_at < ?`).run(cutoff);
  } catch {
    // best effort
  }
}

/** Scan every connected inbox once. Never throws. */
export async function scanBouncesNow(): Promise<{
  inboxes: number;
  paused: string[];
  errors: number;
}> {
  const inboxes = Object.keys(parseGmailAccounts());
  const paused: string[] = [];
  let errors = 0;

  for (const inbox of inboxes) {
    try {
      paused.push(...(await scanInbox(inbox)));
    } catch (err) {
      // One expired refresh token must not stop the other inboxes. Unlike
      // getRecentInboundByContact we never throw on all-failed: this is a
      // background watcher, so it logs and backs off instead.
      errors++;
      state.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  state.lastScanAt = new Date().toISOString();
  if (errors === 0) state.lastError = "";
  prune();
  return { inboxes: inboxes.length, paused, errors };
}

async function loop(myGen: number): Promise<void> {
  // Let the server settle before the first Gmail round-trip.
  await sleep(20_000);
  for (;;) {
    if (state.gen !== myGen) return;
    try {
      const { inboxes, errors } = await scanBouncesNow();
      state.backoffMs =
        errors > 0 && inboxes > 0
          ? Math.min(MAX_BACKOFF_MS, Math.max(SCAN_MS, state.backoffMs * 2))
          : 0;
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      state.backoffMs = Math.min(
        MAX_BACKOFF_MS,
        Math.max(SCAN_MS, state.backoffMs * 2),
      );
    }
    await sleep(state.backoffMs || SCAN_MS);
  }
}

export function startBounceWatch(): void {
  if (state.started) return;
  state.started = true;
  state.gen = (Number.isFinite(state.gen) ? state.gen : 0) + 1;
  const myGen = state.gen;
  if (Object.keys(parseGmailAccounts()).length === 0) {
    console.log("[bounce] watch idle — no Gmail account connected");
  } else {
    console.log("[bounce] block watch armed");
  }
  void loop(myGen);
}

export function bounceWatchStatus() {
  return {
    configured: Object.keys(parseGmailAccounts()).length > 0,
    lastScanAt: state.lastScanAt,
    lastError: state.lastError,
  };
}
