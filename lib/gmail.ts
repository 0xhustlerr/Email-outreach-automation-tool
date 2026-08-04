// Gmail API (read-only) for detecting replies in sender inboxes.
// Requires OAuth refresh tokens per monitored account - see .env.example.

import { htmlToPlainForQuote, stripQuotedReplyBody } from "@/lib/email-quote";
import { getGmailClient, listStoredIdentities } from "@/lib/identities-store";

type TokenCache = { accessToken: string; expiresAt: number };

type GmailAccountOAuth = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

const tokenCache = new Map<string, TokenCache>();

function envOpt(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

/** email (lowercase) → OAuth refresh token */
export function parseGmailRefreshTokens(): Record<string, string> {
  const raw = envOpt("GMAIL_REFRESH_TOKENS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && v.trim()) out[k.toLowerCase()] = v.trim();
      }
      if (Object.keys(out).length > 0) return out;
    } catch {
      // fall through
    }
  }
  const single = envOpt("GMAIL_REFRESH_TOKEN");
  const account = envOpt("GMAIL_SYNC_ACCOUNT");
  if (single && account) {
    return { [account.toLowerCase()]: single };
  }
  return {};
}

/** Per-inbox OAuth (refresh tokens are bound to the client that issued them). */
export function parseGmailAccounts(): Record<string, GmailAccountOAuth> {
  const out: Record<string, GmailAccountOAuth> = {};
  const globalId = envOpt("GMAIL_CLIENT_ID");
  const globalSecret = envOpt("GMAIL_CLIENT_SECRET");
  const refreshes = parseGmailRefreshTokens();

  for (const [email, refreshToken] of Object.entries(refreshes)) {
    if (globalId && globalSecret) {
      out[email] = {
        clientId: globalId,
        clientSecret: globalSecret,
        refreshToken,
      };
    }
  }

  const byAccount = envOpt("GMAIL_OAUTH_BY_ACCOUNT");
  if (byAccount) {
    try {
      const parsed = JSON.parse(byAccount) as Record<
        string,
        { clientId?: string; clientSecret?: string; refreshToken?: string }
      >;
      for (const [email, creds] of Object.entries(parsed)) {
        const key = email.toLowerCase();
        const clientId = creds.clientId?.trim();
        const clientSecret = creds.clientSecret?.trim();
        const refreshToken =
          creds.refreshToken?.trim() ?? refreshes[key] ?? out[key]?.refreshToken;
        if (clientId && clientSecret && refreshToken) {
          out[key] = { clientId, clientSecret, refreshToken };
        }
      }
    } catch {
      // ignore malformed JSON
    }
  }

  const full = envOpt("GMAIL_OAUTH_ACCOUNTS");
  if (full) {
    try {
      const parsed = JSON.parse(full) as Record<
        string,
        { clientId?: string; clientSecret?: string; refreshToken?: string }
      >;
      for (const [email, creds] of Object.entries(parsed)) {
        const key = email.toLowerCase();
        const clientId = creds.clientId?.trim();
        const clientSecret = creds.clientSecret?.trim();
        const refreshToken = creds.refreshToken?.trim();
        if (clientId && clientSecret && refreshToken) {
          out[key] = { clientId, clientSecret, refreshToken };
        }
      }
    } catch {
      // ignore
    }
  }

  // Database (UI-managed) takes precedence over env: a global client id/secret
  // in app_meta, paired with each account's own refresh token. This is what the
  // Accounts page writes, so a shipped build needs no env at all.
  try {
    const client = getGmailClient();
    if (client) {
      for (const s of listStoredIdentities()) {
        const rt = s.oauthRefreshToken?.trim();
        if (rt) {
          out[s.email.toLowerCase()] = {
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            refreshToken: rt,
          };
        }
      }
    }
  } catch {
    // DB not ready — env values (if any) still apply
  }

  return out;
}

/** Validate an OAuth client + refresh token by exchanging it for an access
 *  token, so a bad token is caught when it is entered rather than at sync time. */
export async function verifyGmailOAuth(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
        refresh_token: refreshToken.trim(),
        grant_type: "refresh_token",
      }),
    });
    const data = (await res.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !data.access_token) {
      return {
        ok: false,
        error: data.error_description || data.error || `Token exchange failed (${res.status}).`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "OAuth verification failed" };
  }
}

export function isGmailReplySyncConfigured(): boolean {
  return Object.keys(parseGmailAccounts()).length > 0;
}

/** Exported for bounce-watch, which scans the same inboxes for mailer-daemon
 *  DSNs. Throws when the refresh exchange fails; returns null for an unknown
 *  account. */
export async function getAccessToken(senderEmail: string): Promise<string | null> {
  const key = senderEmail.toLowerCase();
  const account = parseGmailAccounts()[key];
  if (!account) return null;

  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: account.clientId,
      client_secret: account.clientSecret,
      refresh_token: account.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(data.error ?? `Gmail token refresh failed (${res.status}).`);
  }

  tokenCache.set(key, {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  });
  return data.access_token;
}

function gmailAfterDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

/** True if sender inbox has at least one message from contact on/after sendDate. */
export async function hasReplyFromContact(
  senderEmail: string,
  contactEmail: string,
  sendDateIso: string,
): Promise<boolean> {
  const contact = contactEmail.trim().toLowerCase();
  if (!contact || !contact.includes("@")) return false;

  const access = await getAccessToken(senderEmail);
  if (!access) return false;

  const after = gmailAfterDate(sendDateIso);
  const q = after
    ? `from:${contact} after:${after}`
    : `from:${contact}`;

  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", q);
  url.searchParams.set("maxResults", "1");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${access}` },
  });

  const data = (await res.json()) as {
    resultSizeEstimate?: number;
    messages?: { id: string }[];
    error?: { message?: string };
  };

  if (!res.ok) {
    throw new Error(
      data.error?.message ?? `Gmail search failed (${res.status}).`,
    );
  }

  return (
    (data.resultSizeEstimate ?? 0) > 0 ||
    (Array.isArray(data.messages) && data.messages.length > 0)
  );
}

/** Latest reply preview (shared by API + UI). */
export type GmailReplyMessage = {
  id: string;
  subject: string;
  from: string;
  /** Raw Date header from Gmail. */
  date: string;
  /** Parsed receive time (ISO), prefer internalDate from Gmail API. */
  receivedAt: string;
  snippet: string;
  /** Latest reply only - quoted thread stripped. */
  bodyText: string;
  bodyHtml: string;
};

export function parseReceivedAt(
  dateHeader: string,
  internalDateMs?: string,
): string {
  if (internalDateMs) {
    const ms = Number(internalDateMs);
    if (!Number.isNaN(ms) && ms > 0) return new Date(ms).toISOString();
  }
  if (dateHeader.trim()) {
    const t = new Date(dateHeader).getTime();
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return "";
}

function latestReplyBody(
  text: string,
  html: string,
  snippet: string,
): string {
  if (text.trim()) {
    const stripped = stripQuotedReplyBody(text);
    if (stripped) return stripped;
  }
  if (html.trim()) {
    const stripped = stripQuotedReplyBody(htmlToPlainForQuote(html));
    if (stripped) return stripped;
  }
  return stripQuotedReplyBody(snippet);
}

export type GmailMessagePart = {
  mimeType?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
};

export function decodeBase64Url(data: string): string {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const normalized = pad ? padded + "=".repeat(4 - pad) : padded;
  return Buffer.from(normalized, "base64").toString("utf-8");
}

function extractBodies(payload: GmailMessagePart): { text: string; html: string } {
  let text = "";
  let html = "";
  const mime = payload.mimeType ?? "";
  const data = payload.body?.data;
  if (data) {
    const decoded = decodeBase64Url(data);
    if (mime === "text/html") html = decoded;
    else if (mime === "text/plain") text = decoded;
  }
  for (const part of payload.parts ?? []) {
    const nested = extractBodies(part);
    if (!text && nested.text) text = nested.text;
    if (!html && nested.html) html = nested.html;
  }
  return { text, html };
}

export function headerValue(
  headers: { name?: string; value?: string }[] | undefined,
  name: string,
): string {
  const h = headers?.find(
    (x) => (x.name ?? "").toLowerCase() === name.toLowerCase(),
  );
  return h?.value?.trim() ?? "";
}

async function listLatestMessageId(
  access: string,
  contact: string,
  sendDateIso: string,
): Promise<string | null> {
  const after = gmailAfterDate(sendDateIso);
  const q = after ? `from:${contact} after:${after}` : `from:${contact}`;
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", q);
  url.searchParams.set("maxResults", "1");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${access}` },
  });
  const data = (await res.json()) as {
    messages?: { id: string }[];
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(data.error?.message ?? `Gmail search failed (${res.status}).`);
  }
  return data.messages?.[0]?.id ?? null;
}

type GmailMessageResource = {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart & { headers?: { name?: string; value?: string }[] };
  error?: { message?: string };
};

function parseFullMessage(
  messageId: string,
  data: GmailMessageResource,
): GmailReplyMessage {
  const payload = data.payload;
  const { text, html } = payload ? extractBodies(payload) : { text: "", html: "" };
  const dateHeader = headerValue(payload?.headers, "Date");
  const snippet = data.snippet ?? "";
  const bodyLatest = latestReplyBody(text, html, snippet);

  return {
    id: messageId,
    subject: headerValue(payload?.headers, "Subject"),
    from: headerValue(payload?.headers, "From"),
    date: dateHeader,
    receivedAt: parseReceivedAt(dateHeader, data.internalDate),
    snippet,
    bodyText: bodyLatest,
    bodyHtml: html.trim(),
  };
}

async function fetchFullMessage(
  access: string,
  messageId: string,
): Promise<GmailMessageResource> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
  const data = (await res.json()) as GmailMessageResource;
  if (!res.ok) {
    throw new Error(
      data.error?.message ?? `Gmail message fetch failed (${res.status}).`,
    );
  }
  return data;
}

/** Latest message + thread id - shared by preview list and full conversation. */
async function fetchLatestMessageBundle(
  access: string,
  contact: string,
  sendDateIso: string,
): Promise<{ latest: GmailReplyMessage; threadId: string } | null> {
  const messageId = await listLatestMessageId(access, contact, sendDateIso);
  if (!messageId) return null;

  const data = await fetchFullMessage(access, messageId);
  const threadId = data.threadId?.trim();
  if (!threadId) return null;

  return { latest: parseFullMessage(messageId, data), threadId };
}

/** Latest reply from contact in sender inbox (newest first). */
export async function getLatestReplyFromContact(
  senderEmail: string,
  contactEmail: string,
  sendDateIso: string,
): Promise<GmailReplyMessage | null> {
  const contact = contactEmail.trim().toLowerCase();
  if (!contact || !contact.includes("@")) return null;

  const access = await getAccessToken(senderEmail);
  if (!access) return null;

  const bundle = await fetchLatestMessageBundle(access, contact, sendDateIso);
  return bundle?.latest ?? null;
}

export type CrossInboxReplyMatch = {
  latest: GmailReplyMessage;
  receivedInbox: string;
};

/** Search all connected Gmail inboxes for the newest reply from a contact. */
export async function getLatestReplyAcrossInboxes(
  contactEmail: string,
  sendDateIso: string,
  sentFromEmail?: string,
): Promise<CrossInboxReplyMatch | null> {
  const contact = contactEmail.trim().toLowerCase();
  if (!contact.includes("@")) return null;

  const accounts = Object.keys(parseGmailAccounts());
  if (accounts.length === 0) return null;

  const preferred = sentFromEmail?.trim().toLowerCase();
  const ordered = preferred
    ? [
        preferred,
        ...accounts.filter((a) => a !== preferred),
      ]
    : accounts;

  let best: CrossInboxReplyMatch | null = null;
  let bestMs = 0;

  for (const inbox of ordered) {
    if (!accounts.includes(inbox)) continue;
    try {
      const latest = await getLatestReplyFromContact(
        inbox,
        contact,
        sendDateIso,
      );
      if (!latest) continue;
      const ms = latest.receivedAt
        ? new Date(latest.receivedAt).getTime()
        : 0;
      if (!best || ms >= bestMs) {
        bestMs = ms;
        best = { latest, receivedInbox: inbox };
      }
    } catch {
      // try next inbox
    }
  }

  return best;
}

/** Newest inbound message from a given contact, found by scanning the inbox. */
export type InboundReply = {
  id: string;
  receivedAt: string;
  receivedMs: number;
  snippet: string;
  subject: string;
  inbox: string;
};

async function mapWithPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length || 1) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Recent inbound message ids in one inbox, newest first, capped. */
async function listRecentInboundIds(
  access: string,
  sinceDays: number,
  cap: number,
): Promise<string[]> {
  const q = `newer_than:${sinceDays}d -from:me -in:sent -in:chats -in:spam -in:trash`;
  const ids: string[] = [];
  let pageToken: string | undefined;

  while (ids.length < cap) {
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    );
    url.searchParams.set("q", q);
    url.searchParams.set("maxResults", String(Math.min(100, cap - ids.length)));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${access}` },
    });
    const data = (await res.json()) as {
      messages?: { id: string }[];
      nextPageToken?: string;
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new Error(
        data.error?.message ?? `Gmail inbox list failed (${res.status}).`,
      );
    }

    for (const m of data.messages ?? []) ids.push(m.id);
    if (!data.nextPageToken || (data.messages ?? []).length === 0) break;
    pageToken = data.nextPageToken;
  }

  return ids;
}

async function fetchInboundMeta(
  access: string,
  id: string,
  inbox: string,
): Promise<{ fromEmail: string; reply: InboundReply } | null> {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}` +
    `?format=metadata&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=Subject`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
  if (!res.ok) return null;
  const data = (await res.json()) as GmailMessageResource;
  const from = headerValue(data.payload?.headers, "From");
  const fromEmail = parseEmailFromHeader(from);
  if (!fromEmail.includes("@")) return null;

  const dateHeader = headerValue(data.payload?.headers, "Date");
  const receivedAt = parseReceivedAt(dateHeader, data.internalDate);
  return {
    fromEmail,
    reply: {
      id,
      receivedAt,
      receivedMs: receivedAt ? new Date(receivedAt).getTime() : 0,
      snippet: data.snippet ?? "",
      subject: headerValue(data.payload?.headers, "Subject"),
      inbox,
    },
  };
}

/**
 * Newest inbound message per sender across all connected inboxes. Scans what
 * actually arrived (bounded by inbound volume) instead of one query per sent
 * row, so replies to older outreach are still found no matter how many newer
 * emails were sent since.
 */
export async function getRecentInboundByContact(
  sinceDays = 30,
  capPerInbox = 300,
): Promise<Map<string, InboundReply>> {
  const accounts = Object.keys(parseGmailAccounts());
  const byContact = new Map<string, InboundReply>();
  let authFailures = 0;
  let lastAuthError = "";

  for (const inbox of accounts) {
    let access: string | null;
    try {
      access = await getAccessToken(inbox);
    } catch (e) {
      authFailures++;
      lastAuthError = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (!access) {
      authFailures++;
      continue;
    }

    let ids: string[];
    try {
      ids = await listRecentInboundIds(access, sinceDays, capPerInbox);
    } catch {
      continue;
    }

    const metas = await mapWithPool(ids, 10, (id) =>
      fetchInboundMeta(access!, id, inbox).catch(() => null),
    );

    for (const meta of metas) {
      if (!meta) continue;
      const key = meta.fromEmail;
      if (key === inbox.toLowerCase()) continue;
      const existing = byContact.get(key);
      if (!existing || meta.reply.receivedMs >= existing.receivedMs) {
        byContact.set(key, meta.reply);
      }
    }
  }

  // Every inbox failed auth - surface it instead of silently reporting "no
  // replies", which hides expired/revoked refresh tokens.
  if (accounts.length > 0 && authFailures === accounts.length) {
    throw new Error(
      `Gmail authorization failed for all inbox(es)` +
        (lastAuthError ? ` (${lastAuthError})` : "") +
        `. Regenerate the refresh token(s) in GMAIL_REFRESH_TOKENS.`,
    );
  }

  return byContact;
}

export function parseEmailFromHeader(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  if (match) return match[1].trim().toLowerCase();
  const bare = fromHeader.match(/[^\s<>,]+@[^\s<>,]+/i);
  return bare ? bare[0].toLowerCase() : fromHeader.trim().toLowerCase();
}

export type GmailThreadMessage = {
  id: string;
  from: string;
  fromEmail: string;
  receivedAt: string;
  /** Gmail internalDate in ms (tie-break only - clocks can be wrong). */
  receivedMs: number;
  bodyText: string;
  isOutbound: boolean;
  /** RFC Message-ID / In-Reply-To (normalized) - used to order by reply chain. */
  messageId: string;
  inReplyTo: string;
  /** Open-tracking status, populated for OUTBOUND messages that match a tracked
   *  send_log row (by recipient + send time). Absent when untracked. */
  openedAt?: string | null;
  openCount?: number;
};

export type GmailThreadConversation = {
  threadId: string;
  subject: string;
  messages: GmailThreadMessage[];
  latest: GmailReplyMessage;
};

/** List-row preview derived from the same conversation payload as the chat panel. */
export type ReplyListPreview = {
  from: string;
  receivedAt: string;
  snippet: string;
  messageId: string;
};

export function listPreviewFromConversation(
  conv: GmailThreadConversation,
): ReplyListPreview {
  const raw = conv.latest.bodyText.trim() || conv.latest.snippet.trim();
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const snippet =
    oneLine.length > 120 ? `${oneLine.slice(0, 120).trimEnd()}…` : oneLine;

  return {
    from: conv.latest.from,
    receivedAt: conv.latest.receivedAt,
    snippet: snippet || "-",
    messageId: conv.latest.id,
  };
}

function parseThreadMessage(
  msg: {
    id?: string;
    internalDate?: string;
    snippet?: string;
    payload?: GmailMessagePart & {
      headers?: { name?: string; value?: string }[];
    };
  },
  senderEmail: string,
  contactEmail: string,
): GmailThreadMessage | null {
  if (!msg.id || !msg.payload) return null;
  const from = headerValue(msg.payload.headers, "From");
  const fromEmail = parseEmailFromHeader(from);
  const sender = senderEmail.toLowerCase();
  const contact = contactEmail.toLowerCase();
  if (fromEmail !== sender && fromEmail !== contact) return null;

  const { text, html } = extractBodies(msg.payload);
  const dateHeader = headerValue(msg.payload.headers, "Date");
  const bodyText = latestReplyBody(text, html, msg.snippet ?? "");

  return {
    id: msg.id,
    from,
    fromEmail,
    receivedAt: parseReceivedAt(dateHeader, msg.internalDate),
    receivedMs: msg.internalDate ? Number(msg.internalDate) : 0,
    bodyText: bodyText || msg.snippet?.trim() || "",
    isOutbound: fromEmail === sender,
    messageId: normalizeMessageId(headerValue(msg.payload.headers, "Message-ID")),
    inReplyTo: normalizeMessageId(headerValue(msg.payload.headers, "In-Reply-To")),
  };
}

// Message-ID / In-Reply-To headers are wrapped in <…>. Normalize for matching.
function normalizeMessageId(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

// Order a thread by its reply chain (In-Reply-To → Message-ID), NOT by
// timestamp: senders' clocks are often wrong (we've seen replies stamped
// ~14h ahead), which scrambles a purely time-based sort. The chain is the
// ground truth for who-replied-to-what. internalDate only breaks ties among
// siblings. Falls back to time order when a message has no usable headers.
function orderByReplyChain(messages: GmailThreadMessage[]): GmailThreadMessage[] {
  if (messages.length < 2) return messages;

  const byId = new Map<string, GmailThreadMessage>();
  for (const m of messages) {
    if (m.messageId) byId.set(m.messageId, m);
  }
  const childrenOf = new Map<string, GmailThreadMessage[]>();
  const roots: GmailThreadMessage[] = [];
  for (const m of messages) {
    const parent = m.inReplyTo && byId.has(m.inReplyTo) ? m.inReplyTo : "";
    if (parent) {
      const list = childrenOf.get(parent) ?? [];
      list.push(m);
      childrenOf.set(parent, list);
    } else {
      roots.push(m);
    }
  }

  const byTime = (a: GmailThreadMessage, b: GmailThreadMessage) =>
    (a.receivedMs || 0) - (b.receivedMs || 0);
  roots.sort(byTime);

  const ordered: GmailThreadMessage[] = [];
  const seen = new Set<string>();
  const visit = (m: GmailThreadMessage) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    ordered.push(m);
    const kids = (childrenOf.get(m.messageId) ?? []).slice().sort(byTime);
    for (const k of kids) visit(k);
  };
  for (const r of roots) visit(r);
  // Safety net: append anything the walk missed (cycles/orphans), by time.
  for (const m of messages.slice().sort(byTime)) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      ordered.push(m);
    }
  }
  return ordered;
}

/** Full thread - finds the latest reply in any connected inbox (chronological). */
export async function getThreadConversation(
  senderEmail: string,
  contactEmail: string,
  sendDateIso: string,
): Promise<GmailThreadConversation | null> {
  const contact = contactEmail.trim().toLowerCase();
  if (!contact || !contact.includes("@")) return null;

  const match = await getLatestReplyAcrossInboxes(
    contact,
    sendDateIso,
    senderEmail,
  );
  if (!match) return null;

  const { latest, receivedInbox } = match;
  const access = await getAccessToken(receivedInbox);
  if (!access) return null;

  const msgData = await fetchFullMessage(access, latest.id);
  const threadId = msgData.threadId?.trim();
  if (!threadId) return null;

  const threadUrl = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`;
  const threadRes = await fetch(threadUrl, {
    headers: { Authorization: `Bearer ${access}` },
  });
  const thread = (await threadRes.json()) as {
    messages?: {
      id?: string;
      internalDate?: string;
      snippet?: string;
      payload?: GmailMessagePart & {
        headers?: { name?: string; value?: string }[];
      };
    }[];
    error?: { message?: string };
  };
  if (!threadRes.ok) {
    throw new Error(
      thread.error?.message ??
        `Gmail thread fetch failed (${threadRes.status}).`,
    );
  }

  const parsed = (thread.messages ?? [])
    .map((m) => parseThreadMessage(m, receivedInbox, contactEmail))
    .filter((m): m is GmailThreadMessage => m !== null);

  const orderedMessages = orderByReplyChain(parsed);

  return {
    threadId,
    subject: latest.subject,
    messages: orderedMessages.length > 0 ? orderedMessages : [
      {
        id: latest.id,
        from: latest.from,
        fromEmail: parseEmailFromHeader(latest.from),
        receivedAt: latest.receivedAt,
        receivedMs: latest.receivedAt ? new Date(latest.receivedAt).getTime() : 0,
        bodyText: latest.bodyText,
        isOutbound: false,
        messageId: "",
        inReplyTo: "",
      },
    ],
    latest,
  };
}

/** RFC headers for SMTP reply threading. */
export async function getGmailMessageReplyHeaders(
  senderEmail: string,
  gmailMessageId: string,
): Promise<{
  messageId: string;
  references: string;
  subject: string;
} | null> {
  const access = await getAccessToken(senderEmail);
  if (!access) return null;

  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
  const data = (await res.json()) as {
    payload?: { headers?: { name?: string; value?: string }[] };
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(
      data.error?.message ?? `Gmail headers fetch failed (${res.status}).`,
    );
  }

  const messageId = headerValue(data.payload?.headers, "Message-ID");
  const references = headerValue(data.payload?.headers, "References");
  const subject = headerValue(data.payload?.headers, "Subject");
  if (!messageId) return null;

  const refs = references
    ? `${references} ${messageId}`.trim()
    : messageId;

  return { messageId, references: refs, subject };
}
