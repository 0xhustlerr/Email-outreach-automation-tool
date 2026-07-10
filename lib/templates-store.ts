// Server-side template storage. The built-in defaults seed the table once;
// after that the database is the single source of truth and the Manage
// Templates UI edits it. Each template has a `kind`: 'opener' (message 1) or
// 'followup' (message 2, the pitch).

import { db } from "./db";
import { EMAIL_TEMPLATES } from "./email-templates";

export type TemplateKind = "opener" | "followup" | "bump";

export type StoredTemplate = {
  id: string;
  label: string;
  subject: string;
  body: string;
  kind: TemplateKind;
  sort: number;
  updated_at: string;
};

// Default openers — a curated 25 that landed in the Primary inbox (not spam)
// during a deliverability test. Short, LINK-FREE, and written in a loose, human
// "chat" style (lowercase, relaxed punctuation, the odd dropped apostrophe) so
// they read like a real person dashed them off rather than a template blast. The
// opener's only job is to earn a reply; the URL/pitch lives in the follow-up.
// Personalized with {{name}}; {{sender}} is filled at send time.
const OPENER_DEFAULTS = [
  {
    id: "opener-you-around",
    label: "You around for work?",
    subject: "you around?",
    body: "hi {{name}},\n\nyou around for some remote dev work? totally fine if not, just point me the right way\n\ncheers\n{{sender}}",
  },
  {
    id: "opener-room-one-more",
    label: "Room for one more",
    subject: "room for one more?",
    body: "hey {{name}},\n\nlining up some dev work and have room for one more. any chance you're interested? no worries if not\n\n{{sender}}",
  },
  {
    id: "opener-good-time",
    label: "Good time?",
    subject: "good time?",
    body: "hi {{name}},\n\nis now a good time to reach out about dev work, or should i circle back later?\n\ncheers\n{{sender}}",
  },
  {
    id: "opener-still-code",
    label: "Still coding?",
    subject: "still coding?",
    body: "hey {{name}},\n\nyou still coding for clients these days? got something that might suit you if so\n\n{{sender}}",
  },
  {
    id: "opener-two-min",
    label: "Two minutes?",
    subject: "got two mins?",
    body: "hey {{name}},\n\ngot two minutes? theres a small thing i'd like to run past you. no pressure if you're busy\n\ncheers\n{{sender}}",
  },
  {
    id: "opener-keen",
    label: "Keen on work?",
    subject: "keen on some work?",
    body: "hi {{name}},\n\nwould you be keen on some remote dev work? totally fine to say no, just point me the right way if so\n\n{{sender}}",
  },
  {
    id: "opener-bandwidth",
    label: "Any bandwidth?",
    subject: "any bandwidth?",
    body: "hey {{name}},\n\nyou got any bandwidth for a project rn? totally fine if not\n\n{{sender}}",
  },
  {
    id: "opener-extra-hand",
    label: "Extra hand",
    subject: "extra hand?",
    body: "hi {{name}},\n\ni could use an extra hand on some dev work. any chance you're interested?\n\ncheers\n{{sender}}",
  },
  {
    id: "opener-good-moment",
    label: "Good moment?",
    subject: "good moment?",
    body: "hey {{name}},\n\nis this a good moment to reach out about dev work, or should i circle back?\n\n{{sender}}",
  },
  {
    id: "opener-line-up",
    label: "Lining up work",
    subject: "lining up work",
    body: "hi {{name}},\n\nim lining up some dev work and thought of you. you open to it?\n\ncheers\n{{sender}}",
  },
  {
    id: "opener-might-suit",
    label: "Might suit you",
    subject: "might suit you",
    body: "hey {{name}},\n\ni've got something that might suit you. worth sending over, or not your thing?\n\n{{sender}}",
  },
  {
    id: "opener-availability",
    label: "Availability?",
    subject: "your availability?",
    body: "hi {{name}},\n\nwhats your availability like these days? i might have a fit\n\ncheers\n{{sender}}",
  },
  {
    id: "opener-slot-open",
    label: "A slot opened",
    subject: "a slot opened up",
    body: "hey {{name}},\n\na slot opened up on my end for another dev. interested, or should i ask around?\n\n{{sender}}",
  },
  {
    id: "opener-long-collab",
    label: "Long-term collab",
    subject: "long term collab?",
    body: "hey {{name}},\n\nim looking for a long term collaborator, not a one off. might that be you?\n\n{{sender}}",
  },
  {
    id: "opener-touch-base",
    label: "Touching base",
    subject: "touching base",
    body: "hi {{name}},\n\njust touching base - do you take on dev work outside your main gig?\n\ncheers\n{{sender}}",
  },
  {
    id: "opener-good-fit-2",
    label: "Could be a fit",
    subject: "could be a fit",
    body: "hey {{name}},\n\nthink you could be a good fit for some work i've got. open to hearing more?\n\n{{sender}}",
  },
  {
    id: "opener-work-growing",
    label: "Work's growing",
    subject: "work's growing",
    body: "hey {{name}},\n\nmy client work is growing n i need another dev. any interest?\n\n{{sender}}",
  },
  {
    id: "opener-still-freelance",
    label: "Still freelancing?",
    subject: "still freelancing?",
    body: "hi {{name}},\n\nyou still freelancing these days? got something that might fit\n\ncheers\n{{sender}}",
  },
  {
    id: "opener-x07",
    label: "Full stack to build",
    subject: "random reach out",
    body: "hey {{name}},\n\nhope this isn't too out of the blue. been looking to connect with another full stack dev who's keen to build\n\n{{sender}}",
  },
  {
    id: "opener-x12",
    label: "See what comes along",
    subject: "quick msg",
    body: "hey {{name}},\n\nhope you don't mind me dropping you a msg. been thinking it'd be good to know another dev who's up for seeing what comes along. what do you reckon?\n\ncheers\n{{sender}}",
  },
  {
    id: "opener-x21",
    label: "New ideas & opportunities",
    subject: "new ideas",
    body: "hey {{name}},\n\nhope you don't mind the msg. been looking to get to know another dev who's keen on exploring new ideas. fancy a chat?\n\n{{sender}}",
  },
  {
    id: "opener-x25",
    label: "Grab 15 minutes",
    subject: "15 mins?",
    body: "hey {{name}},\n\nyour experience caught my eye. fancy grabbing 15 mins for a quick chat sometime?\n\n{{sender}}",
  },
  {
    id: "opener-x26",
    label: "Like minded developers",
    subject: "like minded devs",
    body: "hey {{name}},\n\nhope you're having a good week. been hoping to meet a few like minded devs n thought i'd start with you. what do you reckon?\n\ncheers\n{{sender}}",
  },
  {
    id: "opener-x27",
    label: "Eye out for opportunities",
    subject: "worth saying hi",
    body: "hey {{name}},\n\nthought it was worth saying hello. do you ever keep an eye out for new opportunities with other devs?\n\n{{sender}}",
  },
  {
    id: "right-person",
    label: "Right person",
    subject: "hey {{name}}",
    body: "hey {{name}},\n\nare you the right person to reach out to about dev work? if not no stress, just point me the right way\n\n{{sender}}",
  },
];

// Bump when OPENER_DEFAULTS changes so existing installs get the new openers.
const OPENERS_SEED_VERSION = "openers-inbox25-v1";

// Non-repliers get ONE short, LINK-FREE bump (a threaded reply) after a couple
// of days. 30 variations so they rotate and never fingerprint. Dash-free.
// {{name}} is substituted by the worker; {{sender}} at send time by the mailer.
const BUMP_LINES: [string, string][] = [
  ["Slipped by", "Just bumping this up in case it slipped by. Any thoughts?"],
  ["Floating up", "Floating this back to the top. Worth a quick chat?"],
  ["Circling back", "Circling back on this. Still keen to connect if you are."],
  ["Reached you?", "Just checking this reached you. No worries if now isn't the time."],
  ["Yes or no", "Following up on my note. A yes or no is totally fine."],
  ["Got buried", "Bumping this once in case it got buried. You around?"],
  ["Gentle nudge", "Gentle nudge on this one. Let me know if it's worth a chat."],
  ["Still here", "Still here if you're open to it. No pressure at all."],
  ["Quick reply", "Just resurfacing this. A quick reply would be great."],
  ["Not lost", "Wanted to make sure this didn't get lost. Any interest?"],
  ["Fine if no", "Popping this back up. Totally fine if it's a no."],
  ["Right person", "Following up quickly. Are you the right person for this?"],
  ["One more", "One more nudge in case you missed it. Worth a quick word?"],
  ["Keep it short", "Checking back in. Happy to keep it short if you're busy."],
  ["Either way", "Just floating this again. Let me know either way."],
  ["Timing off", "Still would love to connect. No stress if the timing's off."],
  ["When you can", "Bumping this up gently. Any thoughts when you get a sec?"],
  ["Once more", "Circling back once more. Open to a quick chat?"],
  ["A fit?", "Wanted to try you again on this. Is it a fit?"],
  ["In the loop", "Quick follow up. Should I keep you in the loop or leave it?"],
  ["Resurfacing", "Resurfacing my note. A yes or no is totally fine."],
  ["Your take", "Just making sure this landed. Keen to hear your take."],
  ["Few minutes", "Nudging this back up. Worth a few minutes?"],
  ["Last time", "Following up one last time. Let me know if you're interested."],
  ["Explain more", "Popping back in. Happy to explain more if useful."],
  ["Still around", "Still around if you'd like to chat. No worries if not."],
  ["Quick call", "Bumping this for you. Any interest in a quick call?"],
  ["In case", "Circling back in case it slipped. You open to it?"],
  ["Later?", "One quick follow up. Should I reach out again later?"],
  ["Checking in", "Just checking in on this. Worth a short chat?"],
];
const BUMP_DEFAULTS = BUMP_LINES.map(([label, line], i) => {
  const greet = i % 2 === 0 ? "Hey" : "Hi";
  const signoff = ["Cheers", "Thanks", "Best"][i % 3];
  return {
    id: `bump-${String(i + 1).padStart(2, "0")}`,
    label,
    subject: "", // threaded reply — subject is derived (Re: opener)
    body: `${greet} {{name}},\n\n${line}\n\n${signoff},\n{{sender}}`,
  };
});
const BUMPS_SEED_VERSION = "bumps-30-v1";

function templateMetaGet(key: string): string | null {
  try {
    const r = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  } catch {
    return null;
  }
}

function templateMetaSet(key: string, value: string): void {
  try {
    db.prepare(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  } catch {
    // ignore
  }
}

function seedIfEmpty(): void {
  // Skip during `next build`: seeding isn't needed to compile, and 15 parallel
  // build workers writing to a fresh DB at once contend (SQLITE_BUSY). Runs
  // normally at runtime.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const count = (
    db.prepare(`SELECT COUNT(*) AS c FROM templates`).get() as { c: number }
  ).c;
  // INSERT OR IGNORE keeps any edited/removed rows intact (matched by id).
  const insert = db.prepare(
    `INSERT OR IGNORE INTO templates (id, label, subject, body, kind, sort, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // Refresh built-in openers to their latest wording on a version bump. This
  // overwrites edits to the DEFAULT openers (intended when the shipped copy is
  // updated); user-created templates keep their own ids and are untouched.
  const replace = db.prepare(
    `INSERT OR REPLACE INTO templates (id, label, subject, body, kind, sort, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();

  if (count === 0) {
    const seedAll = db.transaction(() => {
      OPENER_DEFAULTS.forEach((t, i) => {
        insert.run(t.id, t.label, t.subject, t.body, "opener", i, now);
      });
      EMAIL_TEMPLATES.forEach((t, i) => {
        insert.run(t.id, t.label, t.subject, t.body, "followup", i, now);
      });
      BUMP_DEFAULTS.forEach((t, i) => {
        insert.run(t.id, t.label, t.subject, t.body, "bump", i, now);
      });
    });
    seedAll();
    templateMetaSet("openers_seed_version", OPENERS_SEED_VERSION);
    templateMetaSet("bumps_seed_version", BUMPS_SEED_VERSION);
    return;
  }

  // Existing install: refresh the built-in openers to the latest wording, and
  // retire any built-in openers we no longer ship (e.g. ones dropped after the
  // deliverability prune). Only touches "opener-"-prefixed built-ins; templates
  // the user created themselves keep their own ids and are left alone.
  if (templateMetaGet("openers_seed_version") !== OPENERS_SEED_VERSION) {
    const retire = db.prepare(
      `DELETE FROM templates WHERE kind = 'opener' AND id LIKE 'opener-%' AND id NOT IN (${OPENER_DEFAULTS.map(() => "?").join(", ")})`,
    );
    const topUp = db.transaction(() => {
      OPENER_DEFAULTS.forEach((t, i) => {
        replace.run(t.id, t.label, t.subject, t.body, "opener", i, now);
      });
      retire.run(...OPENER_DEFAULTS.map((t) => t.id));
    });
    topUp();
    templateMetaSet("openers_seed_version", OPENERS_SEED_VERSION);
  }
  // Existing install: seed the bump library once.
  if (templateMetaGet("bumps_seed_version") !== BUMPS_SEED_VERSION) {
    const topUp = db.transaction(() => {
      BUMP_DEFAULTS.forEach((t, i) => {
        insert.run(t.id, t.label, t.subject, t.body, "bump", i, now);
      });
    });
    topUp();
    templateMetaSet("bumps_seed_version", BUMPS_SEED_VERSION);
  }
}

export function listTemplates(kind?: TemplateKind): StoredTemplate[] {
  seedIfEmpty();
  if (kind) {
    return db
      .prepare(`SELECT * FROM templates WHERE kind = ? ORDER BY sort, id`)
      .all(kind) as StoredTemplate[];
  }
  return db
    .prepare(`SELECT * FROM templates ORDER BY kind, sort, id`)
    .all() as StoredTemplate[];
}

export function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "template"
  );
}

/** Insert or update. Returns the saved row (id is generated for new ones). */
export function saveTemplate(input: {
  id?: string;
  label: string;
  subject: string;
  body: string;
  kind?: TemplateKind;
}): StoredTemplate {
  seedIfEmpty();
  const now = new Date().toISOString();
  const kind: TemplateKind =
    input.kind === "followup" || input.kind === "bump" ? input.kind : "opener";

  if (input.id) {
    const res = db
      .prepare(
        `UPDATE templates SET label = ?, subject = ?, body = ?, kind = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.label, input.subject, input.body, kind, now, input.id);
    if (res.changes > 0) {
      return db
        .prepare(`SELECT * FROM templates WHERE id = ?`)
        .get(input.id) as StoredTemplate;
    }
    // Unknown id - fall through and create it with that id.
  }

  // New template: unique slug id, appended at the end of its kind's list.
  let id = input.id || slugify(input.label);
  const exists = db.prepare(`SELECT 1 FROM templates WHERE id = ?`);
  for (let n = 2; exists.get(id); n++) id = `${slugify(input.label)}-${n}`;

  const maxSort = (
    db
      .prepare(`SELECT COALESCE(MAX(sort), -1) AS m FROM templates WHERE kind = ?`)
      .get(kind) as { m: number }
  ).m;
  db.prepare(
    `INSERT INTO templates (id, label, subject, body, kind, sort, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.label, input.subject, input.body, kind, maxSort + 1, now);
  return db
    .prepare(`SELECT * FROM templates WHERE id = ?`)
    .get(id) as StoredTemplate;
}

/** Delete a template. The last remaining template of its kind can't be
 *  deleted, so the send window always has at least one of each. */
export function deleteTemplate(id: string): { ok: boolean; error?: string } {
  seedIfEmpty();
  const row = db
    .prepare(`SELECT kind FROM templates WHERE id = ?`)
    .get(id) as { kind: TemplateKind } | undefined;
  if (!row) return { ok: false, error: "Template not found." };
  const count = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM templates WHERE kind = ?`)
      .get(row.kind) as { c: number }
  ).c;
  if (count <= 1) {
    return { ok: false, error: `Cannot delete the last ${row.kind} template.` };
  }
  const res = db.prepare(`DELETE FROM templates WHERE id = ?`).run(id);
  return res.changes > 0
    ? { ok: true }
    : { ok: false, error: "Template not found." };
}
