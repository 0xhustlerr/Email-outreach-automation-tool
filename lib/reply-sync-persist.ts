import fs from "fs";
import path from "path";
import { db } from "./db";

const DATA_DIR = path.join(process.cwd(), ".data");
const LEGACY_MESSAGE_IDS_FILE = path.join(DATA_DIR, "reply-message-ids.json");

// One-time import of the old JSON store. After migrating, the file is renamed
// (not deleted) so the data is still recoverable if anything looks off.
function migrateLegacyJsonIfPresent(): void {
  try {
    if (!fs.existsSync(LEGACY_MESSAGE_IDS_FILE)) return;
    const raw = fs.readFileSync(LEGACY_MESSAGE_IDS_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const insert = db.prepare(
        `INSERT INTO reply_message_ids (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO NOTHING`,
      );
      const importAll = db.transaction((entries: [string, unknown][]) => {
        for (const [k, v] of entries) {
          if (typeof v === "string" && v) insert.run(k, v);
        }
      });
      importAll(Object.entries(parsed));
    }
    fs.renameSync(
      LEGACY_MESSAGE_IDS_FILE,
      LEGACY_MESSAGE_IDS_FILE + ".migrated",
    );
  } catch {
    // Best-effort - worst case the JSON file is retried on next load.
  }
}

export function loadPersistedMessageIds(): Record<string, string> {
  try {
    migrateLegacyJsonIfPresent();
    const rows = db
      .prepare(`SELECT key, value FROM reply_message_ids`)
      .all() as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  } catch {
    return {};
  }
}

export function savePersistedMessageIds(ids: Record<string, string>): void {
  try {
    const insert = db.prepare(
      `INSERT INTO reply_message_ids (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    const saveAll = db.transaction((entries: [string, string][]) => {
      db.prepare(`DELETE FROM reply_message_ids`).run();
      for (const [k, v] of entries) {
        if (v) insert.run(k, v);
      }
    });
    saveAll(Object.entries(ids));
  } catch {
    // Best-effort - tray/web sync still returns ids to clients.
  }
}
