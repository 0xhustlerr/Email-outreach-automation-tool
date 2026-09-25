// HTML twin of a plain-text email body, built to lay out the same in every
// client. Outlook desktop and Windows Mail render HTML with Word, which ignores
// `white-space: pre-wrap` — so line breaks must be real <p>/<br> structure, and
// font styles sit on every paragraph because Word does not reliably inherit
// them from a wrapper. Deliberately plain (no tables, no branding) so the
// message still reads as a personal email.

const P_STYLE =
  "margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#111111;";
const A_STYLE = "color:#1a0dab;text-decoration:underline;";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Runs of 2+ spaces would collapse to one; keep the first as a real space so
// the line can still wrap there.
function keepSpaces(escaped: string): string {
  return escaped.replace(/ {2,}/g, (m) => " " + "&nbsp;".repeat(m.length - 1));
}

const URL_RE = /https?:\/\/[^\s<>"']+/g;
// Sentence punctuation that follows a URL rather than belonging to it.
const TRAILING_PUNCT_RE = /[.,;:!?)\]]+$/;

/** One line of raw text → escaped HTML with http(s) URLs linked. */
function lineToHtml(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const raw = m[0];
    const trail = raw.match(TRAILING_PUNCT_RE)?.[0] ?? "";
    const url = raw.slice(0, raw.length - trail.length);
    out += keepSpaces(escapeHtml(line.slice(last, start)));
    if (/^https?:\/\/./.test(url)) {
      const u = escapeHtml(url);
      out += `<a href="${u}" style="${A_STYLE}">${u}</a>`;
    } else {
      out += escapeHtml(url);
    }
    out += escapeHtml(trail);
    last = start + raw.length;
  }
  return out + keepSpaces(escapeHtml(line.slice(last)));
}

/** Plain-text body → a complete, Outlook-safe HTML document. Blank lines
 *  separate paragraphs; single newlines become <br>. When `pixelUrl` is given, a
 *  1x1 open-tracking image is appended. */
export function textToEmailHtml(text: string, pixelUrl?: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const paragraphs = normalized
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.trim().length > 0)
    .map((p) => `<p style="${P_STYLE}">${p.split("\n").map(lineToHtml).join("<br>\n")}</p>`);

  const pixel = pixelUrl
    ? `<img src="${escapeHtml(pixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;height:1px;width:1px;overflow:hidden;" />`
    : "";

  return (
    `<!DOCTYPE html>\n` +
    `<html><head>` +
    `<meta http-equiv="Content-Type" content="text/html; charset=utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `</head>\n` +
    `<body style="margin:0;padding:0;">\n` +
    paragraphs.join("\n") +
    (pixel ? `\n${pixel}` : "") +
    `\n</body></html>`
  );
}
