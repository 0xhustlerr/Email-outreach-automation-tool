// Finding a placement-test message in a Gmail inbox and reading where it
// landed. Uses the same read-only OAuth (gmail.readonly) as reply sync.

import { gmailFetch } from "@/lib/gmail";
import type { Placement } from "./types";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

const TAB_LABELS: Record<string, string> = {
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
};

/** Gmail labelIds → placement. Spam wins over everything; a category tab wins
 *  over INBOX (a Promotions message carries both labels). A message with
 *  neither INBOX nor SPAM was archived by a filter or trashed. */
export function labelsToPlacement(labelIds: string[]): {
  placement: Extract<Placement, "inbox" | "tab" | "spam" | "other">;
  detail: string;
} {
  const labels = new Set(labelIds);
  if (labels.has("SPAM")) return { placement: "spam", detail: "" };
  for (const [id, name] of Object.entries(TAB_LABELS)) {
    if (labels.has(id)) return { placement: "tab", detail: name };
  }
  if (labels.has("INBOX")) return { placement: "inbox", detail: "" };
  if (labels.has("TRASH")) return { placement: "other", detail: "Trash" };
  return { placement: "other", detail: "Skipped the inbox (archived)" };
}

/** Gmail search queries for one test message: exact Message-ID first, then
 *  sender + subject + time as a fallback (in case the Message-ID was rewritten
 *  in transit). */
export function placementQueries(m: {
  messageId: string;
  from: string;
  subject: string;
  sentAfterMs: number;
}): string[] {
  const out: string[] = [];
  const id = m.messageId.trim().replace(/^<|>$/g, "");
  if (id) out.push(`rfc822msgid:${id}`);
  const subject = m.subject.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  // A minute of slack: the Date header is the sender's clock, not ours.
  const after = Math.max(0, Math.floor(m.sentAfterMs / 1000) - 60);
  if (m.from && subject) out.push(`from:${m.from} subject:"${subject}" after:${after}`);
  return out;
}

async function searchOne(access: string, q: string): Promise<string | null> {
  const url = new URL(`${API}/messages`);
  url.searchParams.set("q", q);
  url.searchParams.set("maxResults", "1");
  // Spam and Trash are excluded from messages.list unless asked for.
  url.searchParams.set("includeSpamTrash", "true");
  const res = await gmailFetch(url.toString(), {
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

/** Where the test message landed in this inbox, or null when not found yet. */
export async function findPlacement(
  access: string,
  m: { messageId: string; from: string; subject: string; sentAfterMs: number },
): Promise<{ placement: Placement; detail: string } | null> {
  let gmailId: string | null = null;
  for (const q of placementQueries(m)) {
    gmailId = await searchOne(access, q);
    if (gmailId) break;
  }
  if (!gmailId) return null;

  const res = await gmailFetch(`${API}/messages/${gmailId}?format=minimal`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  const data = (await res.json()) as {
    labelIds?: string[];
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(data.error?.message ?? `Gmail message fetch failed (${res.status}).`);
  }
  return labelsToPlacement(data.labelIds ?? []);
}

/** The address an access token belongs to — used to check a pasted seed-inbox
 *  token really is for the address it is being saved under. */
export async function gmailProfileEmail(access: string): Promise<string> {
  const res = await gmailFetch(`${API}/profile`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  const data = (await res.json()) as {
    emailAddress?: string;
    error?: { message?: string };
  };
  if (!res.ok || !data.emailAddress) {
    throw new Error(data.error?.message ?? `Gmail profile lookup failed (${res.status}).`);
  }
  return data.emailAddress.toLowerCase();
}
