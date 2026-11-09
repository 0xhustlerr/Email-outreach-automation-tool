import type { SignatureScope } from "./types";

// HTML twin of a plain-text email body, built to lay out the same in every
// client. Outlook desktop and Windows Mail render HTML with Word, which ignores
// `white-space: pre-wrap` — so line breaks must be real <p>/<br> structure, and
// font styles sit on every paragraph because Word does not reliably inherit
// them from a wrapper. Deliberately plain (no tables, no branding) so the
// message still reads as a personal email.

const P_STYLE =
  "margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#111111;";
const A_STYLE = "color:#1a0dab;text-decoration:underline;";

export function escapeHtml(s: string): string {
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

/** Plain text → styled <p> blocks: blank lines separate paragraphs, single
 *  newlines become <br>. */
function textToParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.trim().length > 0)
    .map((p) => `<p style="${P_STYLE}">${p.split("\n").map(lineToHtml).join("<br>\n")}</p>`);
}

/** Plain-text body → a complete, Outlook-safe HTML document. Blank lines
 *  separate paragraphs; single newlines become <br>. `signatureHtml` (from
 *  renderSignature) goes after the body; when `pixelUrl` is given, a 1x1
 *  open-tracking image is appended last. */
export function textToEmailHtml(
  text: string,
  pixelUrl?: string,
  signatureHtml?: string,
): string {
  const paragraphs = textToParagraphs(text);
  const sig = signatureHtml?.trim() ?? "";

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
    (sig ? `\n${sig}` : "") +
    (pixel ? `\n${pixel}` : "") +
    `\n</body></html>`
  );
}

// --- Signatures ---------------------------------------------------------------
// A Sender's Signature is one string that is either plain text (typed in the
// Accounts page) or HTML (pulled from Gmail, or pasted). Plain text is laid out
// exactly like the body; HTML goes in untouched so links, bold and logos survive.

const TAG_RE = /<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/i;
const SIG_STYLE =
  "font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#111111;";

/** True when the signature contains markup and must be inserted as HTML. An
 *  address in angle brackets ("Ann <ann@x.com>") is not markup. */
export function isHtmlSignature(sig: string): boolean {
  return TAG_RE.test(sig);
}

/** The account that is actually sending, for the {{sender}} placeholders. */
export type SenderVars = { name: string; email: string };

/** Fill {{sender}} / {{sender_email}}. Pass `escape` when the text is HTML so
 *  a display name can't inject markup. */
export function fillSenderVars(
  text: string,
  sender: SenderVars,
  escape: (s: string) => string = (s) => s,
): string {
  return text
    .replace(/\{\{\s*sender_email\s*\}\}/gi, escape(sender.email))
    .replace(/\{\{\s*sender\s*\}\}/gi, escape(sender.name));
}

/** A Signature rendered for both parts of an email, placeholders filled.
 *  `html` is the block textToEmailHtml appends after the body; both are ''
 *  for a blank signature. Plain text vs HTML is decided on the raw signature,
 *  BEFORE filling, so a tag-like display name can't flip a plain-text one into
 *  unescaped HTML. */
export function renderSignature(
  sig: string,
  sender: SenderVars,
): { html: string; text: string } {
  const raw = sig.trim();
  if (!raw) return { html: "", text: "" };
  if (isHtmlSignature(raw)) {
    const filled = fillSenderVars(raw, sender, escapeHtml);
    return {
      html: `<div class="gmail_signature" style="${SIG_STYLE}">${filled}</div>`,
      text: htmlToText(filled),
    };
  }
  const text = fillSenderVars(raw.replace(/\r\n?/g, "\n"), sender);
  return {
    html: `<div class="gmail_signature" style="${SIG_STYLE}">${textToParagraphs(text).join("\n")}</div>`,
    text,
  };
}

// --- The finished email ---------------------------------------------------------

/** Whether a Sender's Signature goes on this email: an Openers-only one stays
 *  off Pitches, Bumps and replies. */
export function signatureApplies(scope: SignatureScope | undefined, isReply?: boolean): boolean {
  return !(scope === "openers" && isReply);
}

/** Everything a send puts on the wire, from the template-filled subject and
 *  body plus the Sender that is actually sending. Pure and client-safe: sendMail
 *  uses it, and so does the Templates page preview, so the two cannot drift. */
export function composeEmail(args: {
  subject: string;
  body: string;
  sender: SenderVars;
  /** The Sender's Signature, plain text or HTML ('' = none). */
  signature?: string;
  signatureScope?: SignatureScope;
  /** A Pitch, Bump or manual reply. Keeps an Openers-only Signature off it. */
  isReply?: boolean;
  /** Open-tracking pixel for the HTML part. */
  pixelUrl?: string;
}): { subject: string; text: string; html: string } {
  const fill = (t: string) => fillSenderVars(t, args.sender);
  const body = fill(args.body);
  const sig = signatureApplies(args.signatureScope, args.isReply)
    ? renderSignature(args.signature ?? "", args.sender)
    : { html: "", text: "" };
  const text = sig.text ? [body.trimEnd(), sig.text].filter(Boolean).join("\n\n") : body;
  return {
    subject: fill(args.subject),
    // Always multipart text+HTML: plain-text-only mail is not safe either —
    // Outlook's default "remove extra line breaks" joins its lines together.
    text,
    html: textToEmailHtml(body, args.pixelUrl, sig.html),
  };
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  middot: "·",
  bull: "•",
  ndash: "–",
  mdash: "—",
  copy: "©",
  reg: "®",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const hex = e[1] === "x" || e[1] === "X";
      const code = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML signature → readable plain text: block elements become line breaks,
 *  links keep their URL ("Site <https://…>"), images and styles are dropped. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Newlines in HTML source are just whitespace; only markup breaks lines.
    .replace(/\s*[\r\n]+\s*/g, " ");

  s = s.replace(
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, dq: string | undefined, sq: string | undefined, bare: string | undefined, inner: string) => {
      const href = decodeEntities(dq ?? sq ?? bare ?? "").trim();
      const text = decodeEntities(inner.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
      if (!/^https?:\/\//i.test(href)) return text; // mailto:, tel:, anchors
      if (!text) return ""; // a linked logo — nothing to read in plain text
      // Marked with control characters, not "<…>", so the tag strip below
      // can't eat the URL; the brackets go back on at the end.
      return text === href || text.includes(href) ? text : `${text} \u0001${href}\u0002`;
    },
  );

  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|ul|ol)\s*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(/<[^>]*>/g, "");

  return decodeEntities(s)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0001/g, "<")
    .replace(/\u0002/g, ">")
    .trim();
}
