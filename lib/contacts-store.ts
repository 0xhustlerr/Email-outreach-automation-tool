// Saved-contacts storage: one row per profile with every email, phone number
// and telegram handle discovery has surfaced for it. Upserts MERGE the
// arrays, so repeated scans only ever add - nothing found earlier is lost.
// The one exception is an explicit edit from the contact form (replace).

import { db } from "./db";

export type SavedContact = {
  key: string;
  login: string;
  profileUrl: string;
  name: string;
  country: string;
  emails: string[];
  phones: string[];
  telegrams: string[];
  updatedAt: string;
  /** Saved by hand via the ☆ button (no send involved). */
  direct: boolean;
  /** Upwork/website link - from the send modal at send time or the ☆ popup. */
  attachedUrl: string;
  /** LinkedIn profile link - from the manual Add/Edit contact modal. */
  linkedinUrl: string;
  /** Derived from send_log: which of this contact's emails were sent to. */
  sentEmails: string[];
  lastSentAt: string | null;
  /** Special = has a fallback channel AND (emailed OR directly saved). */
  special: boolean;
};

type Row = {
  key: string;
  login: string;
  profile_url: string;
  name: string;
  country: string;
  emails: string;
  phones: string;
  telegrams: string;
  updated_at: string;
  direct: number;
  attached_url: string;
  linkedin_url: string;
};

function parseList(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Sent-to info per email address, from the local send log. */
function sentIndex(): Map<string, string> {
  // email(lower) -> latest send date. send_log.contact can hold multiple
  // addresses separated like the sheet does - split the same way.
  const out = new Map<string, string>();
  const rows = db
    .prepare(`SELECT contact, MAX(date) AS d FROM send_log GROUP BY contact`)
    .all() as { contact: string; d: string }[];
  for (const r of rows) {
    for (const part of r.contact.split(/[/,;]/)) {
      const email = part.trim().toLowerCase();
      if (!email.includes("@")) continue;
      const prev = out.get(email);
      if (!prev || r.d > prev) out.set(email, r.d);
    }
  }
  return out;
}

function toContact(r: Row, sent: Map<string, string>): SavedContact {
  const emails = parseList(r.emails);
  const phones = parseList(r.phones);
  const telegrams = parseList(r.telegrams);

  const sentEmails: string[] = [];
  let lastSentAt: string | null = null;
  for (const e of emails) {
    const d = sent.get(e.toLowerCase());
    if (!d) continue;
    sentEmails.push(e);
    if (!lastSentAt || d > lastSentAt) lastSentAt = d;
  }

  const direct = r.direct === 1;
  const hasFallback = phones.length > 0 || telegrams.length > 0;

  return {
    key: r.key,
    login: r.login,
    profileUrl: r.profile_url,
    name: r.name,
    country: r.country,
    emails,
    phones,
    telegrams,
    updatedAt: r.updated_at,
    direct,
    attachedUrl: r.attached_url,
    linkedinUrl: r.linkedin_url,
    sentEmails,
    lastSentAt,
    special: hasFallback && (sentEmails.length > 0 || direct),
  };
}

export function listContacts(): SavedContact[] {
  const rows = db
    .prepare(`SELECT * FROM contacts ORDER BY updated_at DESC`)
    .all() as Row[];
  const sent = sentIndex();
  const contacts = rows.map((r) => toContact(r, sent));
  // Most recently contacted first; never-sent ones by save recency.
  return contacts.sort((a, b) =>
    (b.lastSentAt ?? b.updatedAt).localeCompare(a.lastSentAt ?? a.updatedAt),
  );
}

function mergeList(existing: string[], incoming: string[]): string[] {
  const out = [...existing];
  const seen = new Set(existing.map((v) => v.toLowerCase()));
  for (const v of incoming) {
    const t = v.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

export function upsertContact(input: {
  key: string;
  login?: string;
  profileUrl?: string;
  name?: string;
  country?: string;
  emails?: string[];
  phones?: string[];
  telegrams?: string[];
  direct?: boolean;
  attachedUrl?: string;
  linkedinUrl?: string;
  /**
   * Edit mode: given lists REPLACE the saved ones and given scalars are
   * written as-is ("" clears), so the user can delete a phone or clear a
   * name. Omitted fields and `direct` keep their saved value. Without it,
   * upserts merge and never wipe anything.
   */
  replace?: boolean;
}): SavedContact {
  const key = input.key.trim().toLowerCase();
  const now = new Date().toISOString();
  const existing = db
    .prepare(`SELECT * FROM contacts WHERE key = ?`)
    .get(key) as Row | undefined;

  const prevEmails = existing ? parseList(existing.emails) : [];
  const prevPhones = existing ? parseList(existing.phones) : [];
  const prevTelegrams = existing ? parseList(existing.telegrams) : [];

  const replace = input.replace === true;
  // Scalar: in replace mode a given value wins (blank clears); otherwise a
  // blank input keeps what was saved before. Omitted always keeps.
  const pick = (v: string | undefined, prev: string | undefined): string =>
    replace && v !== undefined ? v.trim() : v?.trim() || prev || "";
  const listJson = (prev: string[], incoming: string[] | undefined): string =>
    JSON.stringify(
      replace && incoming !== undefined
        ? mergeList([], incoming)
        : mergeList(prev, incoming ?? []),
    );

  const next = {
    key,
    login: pick(input.login, existing?.login),
    profile_url: pick(input.profileUrl, existing?.profile_url),
    name: pick(input.name, existing?.name),
    country: pick(input.country, existing?.country),
    emails: listJson(prevEmails, input.emails),
    phones: listJson(prevPhones, input.phones),
    telegrams: listJson(prevTelegrams, input.telegrams),
    // Once direct, always direct - a later send shouldn't erase the fact
    // that the user pinned this contact by hand.
    direct: input.direct ? 1 : (existing?.direct ?? 0),
    attached_url: pick(input.attachedUrl, existing?.attached_url),
    linkedin_url: pick(input.linkedinUrl, existing?.linkedin_url),
    updated_at: now,
  };

  db.prepare(
    `INSERT INTO contacts (key, login, profile_url, name, country, emails, phones, telegrams, direct, attached_url, linkedin_url, updated_at)
     VALUES (@key, @login, @profile_url, @name, @country, @emails, @phones, @telegrams, @direct, @attached_url, @linkedin_url, @updated_at)
     ON CONFLICT(key) DO UPDATE SET
       login = excluded.login, profile_url = excluded.profile_url,
       name = excluded.name, country = excluded.country,
       emails = excluded.emails, phones = excluded.phones,
       telegrams = excluded.telegrams, direct = excluded.direct,
       attached_url = excluded.attached_url,
       linkedin_url = excluded.linkedin_url, updated_at = excluded.updated_at`,
  ).run(next);

  return toContact(
    db.prepare(`SELECT * FROM contacts WHERE key = ?`).get(key) as Row,
    sentIndex(),
  );
}

export function deleteContact(key: string): boolean {
  return (
    db.prepare(`DELETE FROM contacts WHERE key = ?`).run(key.trim().toLowerCase())
      .changes > 0
  );
}
