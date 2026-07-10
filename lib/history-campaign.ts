// Builds the candidate list for a "re-engage from history" two-step campaign:
// past contacts (from send_log) within a date range, deduped to one entry per
// address, keeping the most recent name / url / sender, optionally limited to
// people who never replied.

import { db } from "./db";

export type HistoryCandidate = {
  email: string;
  name: string;
  link: string;
  sender: string;
  country: string;
};

function primaryEmail(contact: string): string {
  const part = contact.split(/[/,;]/)[0]?.trim() ?? "";
  const m = part.match(/[^\s@]+@[^\s@]+\.[^\s@]+/i);
  return m ? m[0].toLowerCase() : part.toLowerCase();
}

/** Candidates for an explicit set of addresses (per-email selection). Looks up
 *  each one's latest name/url/sender from the send log. */
export function candidatesForEmails(emails: string[]): HistoryCandidate[] {
  const out: HistoryCandidate[] = [];
  const seen = new Set<string>();
  const lookup = db.prepare(
    `SELECT contact, name, link, sender, country FROM send_log
     WHERE lower(contact) LIKE ? ORDER BY date DESC LIMIT 1`,
  );
  for (const raw of emails) {
    const email = primaryEmail(raw);
    if (!email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    const r = lookup.get(`%${email}%`) as
      | { contact: string; name: string; link: string; sender: string; country: string }
      | undefined;
    out.push({
      email,
      name: (r?.name ?? "").trim(),
      link: (r?.link ?? "").trim(),
      sender: (r?.sender ?? "").trim(),
      country: (r?.country ?? "").trim(),
    });
  }
  return out;
}

/** Candidates in [fromIso, toIso]. Rows are scanned newest-first so the first
 *  time we see an address we keep its latest name/url/sender. */
export function listHistoryCandidates(
  fromIso: string,
  toIso: string,
  onlyNonReplied: boolean,
): HistoryCandidate[] {
  const rows = db
    .prepare(
      `SELECT contact, name, link, sender, country, active, replied
       FROM send_log
       WHERE date >= ? AND date <= ? AND contact LIKE '%@%'
       ORDER BY date DESC`,
    )
    .all(fromIso, toIso) as {
    contact: string;
    name: string;
    link: string;
    sender: string;
    country: string;
    active: number;
    replied: number;
  }[];

  const seen = new Set<string>();
  const out: HistoryCandidate[] = [];
  for (const r of rows) {
    // "active" is set when a reply is detected (sheet/reply-sync); "replied"
    // is the explicit flag. Either means they answered.
    if (onlyNonReplied && (r.active === 1 || r.replied === 1)) continue;
    const email = primaryEmail(r.contact);
    if (!email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    out.push({
      email,
      name: (r.name ?? "").trim(),
      link: (r.link ?? "").trim(),
      sender: (r.sender ?? "").trim(),
      country: (r.country ?? "").trim(),
    });
  }
  return out;
}
