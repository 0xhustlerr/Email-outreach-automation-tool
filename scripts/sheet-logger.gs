/**
 * Google Apps Script - send-log webhook.
 *
 * How to install:
 *   1. Open your Google Sheet in a browser.
 *   2. Extensions → Apps Script. Delete the default Code.gs contents,
 *      paste this file, and Save.
 *   3. (Optional but recommended) File → Project Settings → Script
 *      Properties → Add property:
 *          SHEET_WEBHOOK_SECRET = <any random string>
 *      Also set SHEETS_WEBHOOK_SECRET to the same value in the app's
 *      .env.local. If unset, the endpoint accepts any caller.
 *   4. Deploy → New deployment → gear icon → "Web app". Set:
 *          Execute as: Me
 *          Who has access: Anyone
 *      Copy the /exec URL into SHEETS_WEBHOOK_URL in .env.local.
 *   5. Restart `npm run dev` so the env var is picked up.
 *
 * The script is header-driven: it reads row 1 of the sheet to map JSON
 * fields onto columns, so rearranging columns in the sheet won't break it.
 * Columns whose headers don't match a known field are left blank.
 */

// Column header -> JSON field. Keys are normalized (lowercased, collapsed
// whitespace) before lookup so variations like "country", "COUNTRY",
// "Column 1", "Column1" and "column_1" all resolve. Keep this aligned
// with the SendLogEntry type in lib/sheets.ts.
const HEADER_TO_FIELD = {
  "date": "date",
  "name": "name",
  "username": "username",
  "github username": "username",
  "site": "site",
  "platform": "site",
  "contact": "contact",
  "email": "contact",
  "link": "link",
  "url": "link",
  "upwork": "link",
  "upwork url": "link",
  "linkedin": "linkLinkedin",
  "linkedin url": "linkLinkedin",
  "linkedin profile": "linkLinkedin",
  "github": "linkGithub",
  "github url": "linkGithub",
  "github profile": "linkGithub",
  "active": "active",
  "replied": "replied",
  "reply": "replied",
  "reply status": "replied",
  "replied at": "repliedAt",
  "repliedat": "repliedAt",
  "country": "country",
  "sender": "sender",
  "sender email": "sender",
  "from": "sender",
  "used email": "sender",
  "column 1": "sender",
  "column1": "sender",
  "mail sent": "mailSent",
  "male sent": "mailSent",
  "sent": "mailSent",
};

function _normalizeHeader(h) {
  return String(h || "")
    .toLowerCase()
    .replace(/[\s_]+/g, " ")
    .trim();
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return _json({ ok: false, error: "missing body" });
    }
    const body = JSON.parse(e.postData.contents);

    if (body.action === "list") {
      return _listRows({
        parameter: {
          secret: body.secret || "",
          sheetName: body.sheetName || "",
          limit: String(body.limit || 50000),
        },
      });
    }

    if (body.action === "batchUpdate") {
      return _batchUpdate(body);
    }

    // Visible in the Executions tab - use this to verify the app is sending
    // the fields you expect (country, sender, username, etc.).
    Logger.log("payload: " + JSON.stringify(body));

    const expected = PropertiesService.getScriptProperties()
      .getProperty("SHEET_WEBHOOK_SECRET");
    if (expected && body.secret !== expected) {
      return _json({ ok: false, error: "unauthorized" });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet =
      (body.sheetName && ss.getSheetByName(body.sheetName)) || ss.getSheets()[0];
    if (!sheet) return _json({ ok: false, error: "no sheet" });

    const lastCol = sheet.getLastColumn();
    if (lastCol < 1) return _json({ ok: false, error: "empty sheet" });

    const rawHeaders = sheet
      .getRange(1, 1, 1, lastCol)
      .getValues()[0];
    // Also log the headers we read, so mismatches are easy to diagnose.
    Logger.log("headers: " + JSON.stringify(rawHeaders));

    const row = rawHeaders.map(function (header) {
      const field = HEADER_TO_FIELD[_normalizeHeader(header)];
      if (!field) return "";
      let value = body[field];

      if (field === "date" && typeof value === "string") {
        const parsed = new Date(value);
        if (!isNaN(parsed.getTime())) value = parsed;
      }
      if (field === "mailSent") value = value ? "Yes" : "";
      if (field === "active" && (value === undefined || value === null || value === "")) {
        value = "no";
      }
      return value == null ? "" : value;
    });

    sheet.appendRow(row);
    return _json({ ok: true, row: sheet.getLastRow() });
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === "rows") {
    return _listRows(e);
  }
  // Simple health check you can visit in the browser after deploying.
  return _json({ ok: true, status: "sheet-logger live" });
}

function _listRows(e) {
  try {
    const expected = PropertiesService.getScriptProperties()
      .getProperty("SHEET_WEBHOOK_SECRET");
    const secret = (e && e.parameter && e.parameter.secret) || "";
    if (expected && secret !== expected) {
      return _json({ ok: false, error: "unauthorized" });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetName = e && e.parameter && e.parameter.sheetName;
    const sheet =
      (sheetName && ss.getSheetByName(sheetName)) || ss.getSheets()[0];
    if (!sheet) return _json({ ok: false, error: "no sheet" });

    const lastCol = sheet.getLastColumn();
    if (lastCol < 1) return _json({ ok: true, rows: [] });

    const rawHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return _json({ ok: true, rows: [] });

    // Default high enough that normal callers get the ENTIRE sheet - a low
    // default here silently hides the oldest rows from the app's History.
    const limit = Math.min(
      parseInt((e && e.parameter && e.parameter.limit) || "50000", 10) || 50000,
      50000,
    );
    const dataStart = Math.max(2, lastRow - limit + 1);
    // getRange's 3rd arg is the ROW COUNT, not the last row - passing lastRow
    // here used to read past the end of the data and return phantom blank rows.
    const data = sheet
      .getRange(dataStart, 1, lastRow - dataStart + 1, lastCol)
      .getValues();

    const rows = data.map(function (rowValues, idx) {
      const obj = { _row: dataStart + idx };
      rawHeaders.forEach(function (header, colIdx) {
        const field = HEADER_TO_FIELD[_normalizeHeader(header)];
        if (!field) return;
        let value = rowValues[colIdx];
        if (value instanceof Date) {
          value = value.toISOString();
        } else if (value != null && value !== "") {
          value = String(value);
        } else {
          value = "";
        }
        obj[field] = value;
      });
      return obj;
    });

    return _json({ ok: true, rows: rows });
  } catch (err) {
    return _json({
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
}

function _batchUpdate(body) {
  try {
    const expected = PropertiesService.getScriptProperties()
      .getProperty("SHEET_WEBHOOK_SECRET");
    if (expected && body.secret !== expected) {
      return _json({ ok: false, error: "unauthorized" });
    }

    const updates = body.updates;
    if (!updates || !updates.length) {
      return _json({ ok: true, updated: 0 });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet =
      (body.sheetName && ss.getSheetByName(body.sheetName)) || ss.getSheets()[0];
    if (!sheet) return _json({ ok: false, error: "no sheet" });

    const lastCol = sheet.getLastColumn();
    if (lastCol < 1) return _json({ ok: false, error: "empty sheet" });

    const rawHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const colByField = {};
    rawHeaders.forEach(function (header, colIdx) {
      const field = HEADER_TO_FIELD[_normalizeHeader(header)];
      if (field) colByField[field] = colIdx + 1;
    });

    var updated = 0;
    updates.forEach(function (item) {
      const rowNum = parseInt(item._row, 10);
      if (!rowNum || rowNum < 2) return;

      ["active", "replied", "repliedAt"].forEach(function (field) {
        if (item[field] === undefined || item[field] === null) return;
        const col = colByField[field];
        if (!col) return;
        let value = item[field];
        if (field === "repliedAt" && typeof value === "string") {
          const parsed = new Date(value);
          if (!isNaN(parsed.getTime())) value = parsed;
        }
        sheet.getRange(rowNum, col).setValue(value);
      });
      updated++;
    });

    return _json({ ok: true, updated: updated });
  } catch (err) {
    return _json({
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
