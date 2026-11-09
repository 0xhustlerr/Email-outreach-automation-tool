// Storage for placement tests, their per-seed results, and the extra seed
// inboxes. Tables are created in lib/db.ts.

import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import {
  emptyCounts,
  type Placement,
  type PlacementProviderId,
  type PlacementResultRow,
  type PlacementTestRow,
  type PlacementTestStatus,
  type PlacementTestView,
  type ResultUpdate,
} from "./types";

// --- tests -------------------------------------------------------------------

export function createTest(input: {
  sender: string;
  provider: PlacementProviderId;
  templateId: string;
  subject: string;
}): PlacementTestRow {
  const row: PlacementTestRow = {
    id: randomUUID(),
    sender: input.sender.trim().toLowerCase(),
    provider: input.provider,
    template_id: input.templateId,
    subject: input.subject,
    status: "sending",
    external_id: "",
    error: "",
    created_at: new Date().toISOString(),
    sent_at: null,
    finished_at: null,
    checked_at: null,
  };
  db.prepare(
    `INSERT INTO placement_tests
       (id, sender, provider, template_id, subject, status, external_id, error,
        created_at, sent_at, finished_at, checked_at)
     VALUES (@id, @sender, @provider, @template_id, @subject, @status, @external_id,
        @error, @created_at, @sent_at, @finished_at, @checked_at)`,
  ).run(row);
  return row;
}

export function getTest(id: string): PlacementTestRow | null {
  return (
    (db.prepare(`SELECT * FROM placement_tests WHERE id = ?`).get(id) as
      | PlacementTestRow
      | undefined) ?? null
  );
}

export function updateTest(
  id: string,
  patch: Partial<
    Pick<
      PlacementTestRow,
      "status" | "external_id" | "error" | "sent_at" | "finished_at" | "checked_at"
    >
  >,
): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE placement_tests SET ${sets} WHERE id = @id`).run({ ...patch, id });
}

/** Sending finished: start waiting for results. Only moves a test that is
 *  still "sending", so a test already closed out (e.g. failed) stays closed. */
export function markSent(id: string): void {
  db.prepare(
    `UPDATE placement_tests SET status = 'running', sent_at = ? WHERE id = ? AND status = 'sending'`,
  ).run(new Date().toISOString(), id);
}

/** Drop every test (and its results) for a Sender being removed. */
export function deleteTestsForSender(sender: string): void {
  const s = sender.trim().toLowerCase();
  db.transaction(() => {
    db.prepare(
      `DELETE FROM placement_results WHERE test_id IN
         (SELECT id FROM placement_tests WHERE sender = ?)`,
    ).run(s);
    db.prepare(`DELETE FROM placement_tests WHERE sender = ?`).run(s);
  })();
}

export function finishTest(id: string, status: Extract<PlacementTestStatus, "done" | "failed">, error = ""): void {
  updateTest(id, { status, error, finished_at: new Date().toISOString() });
}

export function listTestsByStatus(status: PlacementTestStatus): PlacementTestRow[] {
  return db
    .prepare(`SELECT * FROM placement_tests WHERE status = ? ORDER BY created_at`)
    .all(status) as PlacementTestRow[];
}

/** Newest tests for each sender, newest first, `perSender` deep. */
export function listRecentTests(perSender = 5): PlacementTestRow[] {
  return db
    .prepare(
      `SELECT id, sender, provider, template_id, subject, status, external_id, error,
              created_at, sent_at, finished_at, checked_at
       FROM (
         SELECT t.*, ROW_NUMBER() OVER (PARTITION BY sender ORDER BY created_at DESC) AS rn
         FROM placement_tests t
       ) WHERE rn <= ? ORDER BY sender, created_at DESC`,
    )
    .all(perSender) as PlacementTestRow[];
}

// --- results -----------------------------------------------------------------

export function insertResults(
  testId: string,
  rows: { seed: string; seedProvider: string; messageId: string; placement: Placement; detail?: string }[],
): void {
  const stmt = db.prepare(
    `INSERT INTO placement_results
       (test_id, seed, seed_provider, message_id, placement, detail, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(test_id, seed) DO UPDATE SET
       seed_provider = excluded.seed_provider,
       message_id = excluded.message_id,
       placement = excluded.placement,
       detail = excluded.detail`,
  );
  db.transaction(() => {
    for (const r of rows) {
      stmt.run(
        testId,
        r.seed.trim().toLowerCase(),
        r.seedProvider,
        r.messageId,
        r.placement,
        r.detail ?? "",
      );
    }
  })();
}

export function listResults(testId: string): PlacementResultRow[] {
  return db
    .prepare(`SELECT * FROM placement_results WHERE test_id = ? ORDER BY seed`)
    .all(testId) as PlacementResultRow[];
}

/** Apply collected placements. A seed the provider reports that we never
 *  recorded (a seed service's list changed) is added rather than dropped. */
export function applyUpdates(testId: string, updates: ResultUpdate[]): void {
  if (updates.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO placement_results
       (test_id, seed, seed_provider, message_id, placement, detail, checked_at)
     VALUES (@test_id, @seed, @seed_provider, '', @placement, @detail, @checked_at)
     ON CONFLICT(test_id, seed) DO UPDATE SET
       placement = excluded.placement,
       detail = excluded.detail,
       checked_at = excluded.checked_at,
       seed_provider = CASE WHEN excluded.seed_provider = '' THEN seed_provider
                            ELSE excluded.seed_provider END`,
  );
  db.transaction(() => {
    for (const u of updates) {
      stmt.run({
        test_id: testId,
        seed: u.seed.trim().toLowerCase(),
        seed_provider: u.seedProvider ?? "",
        placement: u.placement,
        detail: u.detail ?? "",
        checked_at: now,
      });
    }
  })();
}

export function toView(test: PlacementTestRow, results = listResults(test.id)): PlacementTestView {
  const counts = emptyCounts();
  for (const r of results) {
    counts[r.placement] += 1;
    counts.total += 1;
  }
  return {
    id: test.id,
    sender: test.sender,
    provider: test.provider,
    templateId: test.template_id,
    subject: test.subject,
    status: test.status,
    error: test.error,
    createdAt: test.created_at,
    sentAt: test.sent_at,
    finishedAt: test.finished_at,
    counts,
    results: results.map((r) => ({
      seed: r.seed,
      seedProvider: r.seed_provider,
      placement: r.placement,
      detail: r.detail,
      checkedAt: r.checked_at,
    })),
  };
}

// --- which seed inboxes receive tests -------------------------------------------
// Stored as the UNCHECKED set, so a newly connected Sender or a newly added
// seed inbox receives tests from the start.

const DISABLED_SEEDS_KEY = "placement_disabled_seeds";

export function disabledSeeds(): Set<string> {
  try {
    const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(DISABLED_SEEDS_KEY) as
      | { value: string }
      | undefined;
    const list = JSON.parse(row?.value ?? "[]");
    return new Set(Array.isArray(list) ? list.map((e) => String(e).toLowerCase()) : []);
  } catch {
    return new Set();
  }
}

/** Check or uncheck a seed inbox for future tests. */
export function setSeedEnabled(email: string, enabled: boolean): void {
  const e = email.trim().toLowerCase();
  const set = disabledSeeds();
  if (enabled) set.delete(e);
  else set.add(e);
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(DISABLED_SEEDS_KEY, JSON.stringify([...set].sort()));
}

// --- seed inboxes --------------------------------------------------------------

export type SeedInbox = {
  email: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  createdAt: string;
};

type SeedRow = {
  email: string;
  oauth_refresh_token: string;
  oauth_client_id: string;
  oauth_client_secret: string;
  created_at: string;
};

function seedFromRow(r: SeedRow): SeedInbox {
  return {
    email: r.email,
    refreshToken: r.oauth_refresh_token,
    clientId: r.oauth_client_id,
    clientSecret: r.oauth_client_secret,
    createdAt: r.created_at,
  };
}

export function listSeedInboxes(): SeedInbox[] {
  try {
    return (
      db.prepare(`SELECT * FROM seed_inboxes ORDER BY created_at`).all() as SeedRow[]
    ).map(seedFromRow);
  } catch {
    return [];
  }
}

/** Seed inboxes as the API shows them — never the tokens. */
export function publicSeedInboxes(): { email: string; createdAt: string }[] {
  return listSeedInboxes().map((s) => ({ email: s.email, createdAt: s.createdAt }));
}

export function getSeedInbox(email: string): SeedInbox | null {
  const r = db
    .prepare(`SELECT * FROM seed_inboxes WHERE email = ?`)
    .get(email.trim().toLowerCase()) as SeedRow | undefined;
  return r ? seedFromRow(r) : null;
}

export function upsertSeedInbox(s: {
  email: string;
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
}): void {
  db.prepare(
    `INSERT INTO seed_inboxes (email, oauth_refresh_token, oauth_client_id, oauth_client_secret, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       oauth_refresh_token = excluded.oauth_refresh_token,
       oauth_client_id = excluded.oauth_client_id,
       oauth_client_secret = excluded.oauth_client_secret`,
  ).run(
    s.email.trim().toLowerCase(),
    s.refreshToken.trim(),
    (s.clientId ?? "").trim(),
    (s.clientSecret ?? "").trim(),
    new Date().toISOString(),
  );
}

export function deleteSeedInbox(email: string): boolean {
  const e = email.trim().toLowerCase();
  const removed = db.prepare(`DELETE FROM seed_inboxes WHERE email = ?`).run(e).changes > 0;
  // Re-adding it later starts checked, like any new seed inbox.
  if (removed) setSeedEnabled(e, true);
  return removed;
}
