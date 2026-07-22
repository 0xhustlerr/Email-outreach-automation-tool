// CSV parsing for the bulk lead import (see components/ImportCsvModal.tsx).
// Isomorphic and dependency-free: the browser parses the picked file and POSTs
// the resulting rows as JSON, so this module must not touch node APIs.

/** RFC4180 rows: quoted fields, "" escapes, embedded commas/newlines, CRLF. */
export function parseCsv(text: string): string[][] {
  // Strip a UTF-8 BOM - Excel writes one and it would poison the first header.
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      // Treat \r\n as one break; a lone \r (old Mac) also ends the row.
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // Flush the trailing field/row unless the file ended on a clean newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export type CsvLead = {
  name: string;
  country: string;
  upworkUrl: string;
  githubUrl: string;
  linkedinUrl: string;
};

export type ParsedLeadCsv = {
  rows: CsvLead[];
  /** Row-level problems (1-based line numbers), shown above the import log. */
  errors: string[];
  /** Header cells we couldn't map, for the "unrecognized column" hint. */
  unmapped: string[];
};

type Field = keyof CsvLead;

// Header matching is fuzzy: the spec header is
// "Name, Country(Optional), Upwork Url (optional), GitHub Url, LinkedIn Url",
// but exports vary ("github_url", "GitHub Profile", "linkedin"). Compare on
// alphanumerics only and match by keyword.
function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function classifyHeader(raw: string): Field | null {
  const h = normalizeHeader(raw);
  if (!h) return null;
  if (h.includes("github")) return "githubUrl";
  if (h.includes("linkedin")) return "linkedinUrl";
  if (h.includes("upwork")) return "upworkUrl";
  if (h.includes("country") || h.includes("location")) return "country";
  if (h === "name" || h.includes("fullname") || h.includes("clientname"))
    return "name";
  return null;
}

// A file with no recognizable header row still imports: fall back to the
// documented column order.
const POSITIONAL: Field[] = [
  "name",
  "country",
  "upworkUrl",
  "githubUrl",
  "linkedinUrl",
];

function looksLikeUrl(v: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(v.trim()) || v.includes(".com/");
}

/** Parse a lead CSV into typed rows. Rows without a GitHub URL are dropped and
 *  reported in `errors` - they can't be discovered, but the user should know. */
export function parseLeadCsv(text: string): ParsedLeadCsv {
  const grid = parseCsv(text);
  if (grid.length === 0) {
    return { rows: [], errors: ["The file is empty."], unmapped: [] };
  }

  const head = grid[0];
  const mapped = head.map(classifyHeader);
  const hasHeader =
    mapped.some((m) => m !== null) && !head.some((c) => looksLikeUrl(c));
  const columns: (Field | null)[] = hasHeader
    ? mapped
    : head.map((_, i) => POSITIONAL[i] ?? null);
  const unmapped = hasHeader
    ? head.filter((c, i) => mapped[i] === null && c.trim() !== "")
    : [];

  const body = hasHeader ? grid.slice(1) : grid;
  const rows: CsvLead[] = [];
  const errors: string[] = [];

  body.forEach((cells, idx) => {
    const line = (hasHeader ? idx + 2 : idx + 1).toString();
    const lead: CsvLead = {
      name: "",
      country: "",
      upworkUrl: "",
      githubUrl: "",
      linkedinUrl: "",
    };
    columns.forEach((field, i) => {
      if (!field) return;
      const v = (cells[i] ?? "").trim();
      if (v) lead[field] = v;
    });
    if (!lead.githubUrl) {
      errors.push(`Line ${line}: no GitHub URL${lead.name ? ` (${lead.name})` : ""}`);
      return;
    }
    rows.push(lead);
  });

  return { rows, errors, unmapped };
}
