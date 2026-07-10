// History sync between the Google Sheet and the local SQLite database.
//
// The database is the read source for the History UI (instant, works when the
// sheet is unreachable). The sheet stays the write target for reply-sync row
// updates and remains editable by hand - so after every fetch we reconcile it
// into the database:
//
//   - match sheet rows to db rows by (date, contact, sender) - the exact ISO
//     date string is preserved by the Apps Script logger, so this is stable
//   - copy sheet_row plus any manually edited cells (name, link, active, ...)
//   - insert sheet rows the db has never seen (added outside the app)
//   - `replied` is OR-merged: a reply seen by either side stays recorded
//
// Reconciliation is throttled and normally fire-and-forget; only the very
// first run (no sheet_row values yet) is awaited so the UI gets _row keys -
// reply notifications are keyed by sheet row number.

import { db } from "./db";
import { normalizeCountry } from "./country";
import {
  fetchSheetHistory,
  isSheetsLoggerConfigured,
  type SheetHistoryRow,
} from "./sheets";

const RECONCILE_MIN_INTERVAL_MS = 30_000;

type SyncState = {
  lastReconcileMs: number;
  inFlight: Promise<void> | null;
};
const globalForSync = globalThis as unknown as { __historySync?: SyncState };
const state: SyncState =
  globalForSync.__historySync ?? { lastReconcileMs: 0, inFlight: null };
globalForSync.__historySync = state;

const isYes = (v: string | undefined) =>
  ["yes", "y", "true", "1"].includes((v ?? "").trim().toLowerCase());

function reconcileRows(rows: SheetHistoryRow[]): void {
  const findByKey = db.prepare(
    `SELECT id FROM send_log WHERE date = ? AND contact = ? AND sender = ? LIMIT 1`,
  );
  const update = db.prepare(
    `UPDATE send_log SET
       sheet_row   = @sheetRow,
       name        = @name,
       username    = @username,
       country     = @country,
       country_std = @countryStd,
       site        = @site,
       link        = @link,
       mail_sent   = @mailSent,
       active      = @active,
       replied     = MAX(replied, @replied),
       replied_at  = COALESCE(replied_at, @repliedAt)
     WHERE id = @id`,
  );
  const insert = db.prepare(
    `INSERT INTO send_log (date, name, username, country, country_std, site, contact, link, sender,
                           mail_sent, replied, replied_at, active, sheet_row)
     VALUES (@date, @name, @username, @country, @countryStd, @site, @contact, @link, @sender,
             @mailSent, @replied, @repliedAt, @active, @sheetRow)`,
  );

  const apply = db.transaction((sheetRows: SheetHistoryRow[]) => {
    for (const r of sheetRows) {
      const date = (r.date ?? "").trim();
      const contact = (r.contact ?? "").trim();
      const sender = (r.sender ?? "").trim();
      if (!date && !contact) continue; // blank sheet row

      const country = (r.country ?? "").trim();
      const mapped = {
        sheetRow: r._row ?? null,
        date,
        contact,
        sender,
        name: (r.name ?? "").trim(),
        username: (r.username ?? "").trim(),
        country,
        countryStd: normalizeCountry(country) ?? "",
        site: (r.site ?? "").trim(),
        link: (r.link ?? "").trim(),
        mailSent: isYes(r.mailSent) ? 1 : 0,
        active: isYes(r.active) ? 1 : 0,
        replied: isYes(r.replied) ? 1 : 0,
        repliedAt: (r.repliedAt ?? "").trim() || null,
      };

      const existing = findByKey.get(date, contact, sender) as
        | { id: number }
        | undefined;
      if (existing) {
        update.run({ ...mapped, id: existing.id });
      } else {
        insert.run(mapped);
      }
    }
  });
  apply(rows);
}

/** Fetch the sheet and fold it into the database. Throttled; concurrent
 *  callers share one in-flight run. Never throws. */
export async function reconcileSheetToDb(force = false): Promise<void> {
  if (!isSheetsLoggerConfigured()) return;
  if (state.inFlight) return state.inFlight;
  if (!force && Date.now() - state.lastReconcileMs < RECONCILE_MIN_INTERVAL_MS) {
    return;
  }

  state.inFlight = (async () => {
    try {
      const rows = await fetchSheetHistory();
      if (rows.length > 0) reconcileRows(rows);
      state.lastReconcileMs = Date.now();
    } catch {
      // Sheet unreachable - the db copy keeps serving; next call retries.
    } finally {
      state.inFlight = null;
    }
  })();
  return state.inFlight;
}

/** True until the first reconcile has attached sheet row numbers. */
export function dbNeedsFirstReconcile(): boolean {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM send_log WHERE sheet_row IS NOT NULL`)
      .get() as { c: number };
    return row.c === 0;
  } catch {
    return false;
  }
}

/** History rows for the UI, from the database, in sheet order. Rows not yet
 *  reconciled (sent seconds ago) sort last, like a fresh sheet append. */
/** One-time: populate country_std for existing rows that don't have it yet,
 *  from the raw free-form country. Safe to run repeatedly. */
export function backfillCountryStd(): number {
  const rows = db
    .prepare(
      `SELECT id, country FROM send_log WHERE country_std = '' AND TRIM(country) != ''`,
    )
    .all() as { id: number; country: string }[];
  if (rows.length === 0) return 0;
  const upd = db.prepare(`UPDATE send_log SET country_std = ? WHERE id = ?`);
  const run = db.transaction(() => {
    let n = 0;
    for (const r of rows) {
      const std = normalizeCountry(r.country);
      if (std) {
        upd.run(std, r.id);
        n++;
      }
    }
    return n;
  });
  return run();
}

/** Soft-delete history rows for the given addresses (hidden from the view,
 *  preserved across sheet re-sync). Returns rows affected. */
export function softDeleteHistoryByEmails(emails: string[]): number {
  const clean = emails
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
  if (clean.length === 0) return 0;
  const stmt = db.prepare(
    `UPDATE send_log SET deleted = 1 WHERE lower(contact) LIKE ?`,
  );
  const run = db.transaction((list: string[]) => {
    let n = 0;
    for (const e of list) n += stmt.run(`%${e}%`).changes;
    return n;
  });
  return run(clean);
}

export function listHistoryFromDb(): SheetHistoryRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM send_log
       WHERE deleted = 0
       ORDER BY (sheet_row IS NULL), sheet_row, id`,
    )
    .all() as import("./db").SendLogRow[];

  return rows.map((r) => ({
    _row: r.sheet_row ?? undefined,
    date: r.date,
    name: r.name,
    username: r.username,
    country: r.country,
    site: r.site,
    contact: r.contact,
    link: r.link,
    sender: r.sender,
    mailSent: r.mail_sent ? "yes" : "",
    active: r.active ? "yes" : "no",
    replied: r.replied ? "yes" : "",
    repliedAt: r.replied_at ?? "",
    openedAt: r.opened_at ?? "",
    openCount: r.open_count ?? 0,
  }));
}
