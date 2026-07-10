// Posts a row to a Google Sheets Apps Script web app whenever a send
// succeeds. The web app is a small script bound to the sheet; see
// scripts/sheet-logger.gs for the exact code and deploy steps.
//
// Disabled by default: without SHEETS_WEBHOOK_URL the exported functions are
// no-ops, so forgetting to set it up never breaks the send flow.

/** One row from the send log sheet (read via Apps Script `?action=rows`). */
export type SheetHistoryRow = {
  _row?: number;
  date: string;
  name: string;
  username: string;
  country: string;
  site: string;
  contact: string;
  link: string;
  sender: string;
  mailSent: string;
  active?: string;
  replied?: string;
  repliedAt?: string;
  /** Open tracking (local only; not synced to the sheet). */
  openedAt?: string;
  openCount?: number;
};

export type SheetRowUpdate = {
  _row: number;
  active?: string;
  replied?: string;
  repliedAt?: string;
};

export type SendLogEntry = {
  // ISO 8601. The Apps Script side receives a string and lets the spreadsheet
  // format it using the sheet's locale/timezone.
  date: string;
  // Recipient name from the modal's "Name" field - left blank if the user
  // didn't fill it in.
  name: string;
  // GitHub login of the profile being researched, when we have it.
  username: string;
  // Country extracted from the GitHub profile's `location` field. Free-form
  // so best-effort - blank when the profile has no location or the tail
  // segment isn't recognisable as a country.
  country: string;
  // Derived from the URL host: Upwork / Stack Overflow / LinkedIn / domain.
  site: string;
  // Recipient email.
  contact: string;
  // The URL pasted into the modal (Upwork profile, etc.) - *not* the GitHub
  // profile URL. This matches the Link column in the sheet.
  link: string;
  // Sender identity that was picked in the From: dropdown.
  sender: string;
  // true when SMTP reported success. The script fills "Yes" in the "mail
  // sent" column when true; leaves it blank otherwise.
  mailSent: boolean;
};

const SENT_TIMEOUT_MS = 5_000;
const HISTORY_TIMEOUT_MS = 15_000;

function envOpt(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

export function isSheetsLoggerConfigured(): boolean {
  return !!envOpt("SHEETS_WEBHOOK_URL");
}

// Maps a URL host to a short, human-readable platform name. Unknown hosts
// come back as the bare domain so the cell is never empty when we have a URL.
export function deriveSite(url: string): string {
  const trimmed = (url || "").trim();
  if (!trimmed) return "";
  let host: string;
  try {
    host = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    ).hostname.toLowerCase();
  } catch {
    return "";
  }
  host = host.replace(/^www\./, "");
  switch (host) {
    case "upwork.com":
      return "Upwork";
    case "stackoverflow.com":
      return "Stack Overflow";
    case "github.com":
      return "GitHub";
    case "linkedin.com":
      return "LinkedIn";
    case "freelancer.com":
      return "Freelancer";
    case "fiverr.com":
      return "Fiverr";
    case "toptal.com":
      return "Toptal";
    default:
      return host;
  }
}

const SHEET_HISTORY_DEPLOY_MSG =
  "Sheet history is not available yet. Open your Google Sheet → Extensions → Apps Script, paste the latest scripts/sheet-logger.gs, then Deploy → Manage deployments → Edit → New version → Deploy. Restart npm run dev and try History again.";

const SHEET_WEBHOOK_ACCESS_MSG =
  'Apps Script must be deployed with "Who has access: Anyone". Redeploy the web app (Execute as: Me, access: Anyone) and use the new /exec URL in SHEETS_WEBHOOK_URL.';

type SheetHistoryResponse = {
  ok?: boolean;
  rows?: SheetHistoryRow[];
  status?: string;
  error?: string;
};

function parseSheetHistoryResponse(data: SheetHistoryResponse): SheetHistoryRow[] {
  if (!data.ok) {
    throw new Error(data.error ?? "Failed to fetch sheet history.");
  }
  // Old deployments only expose a health check on GET and omit `rows`.
  if (data.rows === undefined && data.status === "sheet-logger live") {
    throw new Error(SHEET_HISTORY_DEPLOY_MSG);
  }
  return data.rows ?? [];
}

export async function fetchSheetHistory(): Promise<SheetHistoryRow[]> {
  const webhook = envOpt("SHEETS_WEBHOOK_URL");
  if (!webhook) return [];

  const sheetName = envOpt("SHEETS_TAB_NAME") ?? "Table1";
  const secret = envOpt("SHEETS_WEBHOOK_SECRET") ?? undefined;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HISTORY_TIMEOUT_MS);
  try {
    // GET first - old deployments only return a health check and never write.
    const url = new URL(webhook);
    url.searchParams.set("action", "rows");
    if (secret) url.searchParams.set("secret", secret);
    url.searchParams.set("sheetName", sheetName);
    // Without this the Apps Script defaults to the LAST 1000 rows and silently
    // drops the oldest history. 5000 is the cap in older deployments; newer
    // sheet-logger.gs accepts up to 50000.
    url.searchParams.set("limit", "50000");

    const getRes = await fetch(url.toString(), {
      redirect: "follow",
      signal: ac.signal,
    });
    const raw = await getRes.text();
    if (
      raw.includes("accounts.google.com") ||
      raw.trimStart().startsWith("<!") ||
      raw.trimStart().startsWith("<html")
    ) {
      throw new Error(SHEET_WEBHOOK_ACCESS_MSG);
    }
    let getData: SheetHistoryResponse;
    try {
      getData = JSON.parse(raw) as SheetHistoryResponse;
    } catch {
      throw new Error(
        "Sheet webhook returned invalid JSON. Check SHEETS_WEBHOOK_URL and redeploy the Apps Script web app.",
      );
    }
    return parseSheetHistoryResponse(getData);
  } finally {
    clearTimeout(timer);
  }
}

export async function batchUpdateSheetRows(
  updates: SheetRowUpdate[],
): Promise<void> {
  const webhook = envOpt("SHEETS_WEBHOOK_URL");
  if (!webhook || updates.length === 0) return;

  const payload = {
    action: "batchUpdate",
    secret: envOpt("SHEETS_WEBHOOK_SECRET") ?? undefined,
    sheetName: envOpt("SHEETS_TAB_NAME") ?? "Table1",
    updates,
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HISTORY_TIMEOUT_MS);
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: ac.signal,
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!data.ok) {
      throw new Error(data.error ?? "Failed to update sheet rows.");
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function logSendToSheet(entry: SendLogEntry): Promise<void> {
  const webhook = envOpt("SHEETS_WEBHOOK_URL");
  if (!webhook) return;

  const payload = {
    secret: envOpt("SHEETS_WEBHOOK_SECRET") ?? undefined,
    sheetName: envOpt("SHEETS_TAB_NAME") ?? "Table1",
    ...entry,
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SENT_TIMEOUT_MS);
  try {
    // `redirect: "follow"` - Apps Script web app URLs 302 to a
    // script.googleusercontent.com domain before actually running.
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: ac.signal,
    });
  } catch {
    // Intentionally swallow - this logger is best-effort. If the sheet is
    // down, network is out, or the URL is wrong, the email still went out
    // and we don't want to return a 500 to the user over a logging failure.
  } finally {
    clearTimeout(timer);
  }
}
