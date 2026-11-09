// Filling a template's contact placeholders ({{name}}, {{url}}, …). Pure and
// client-safe: the queue, the import routes, the Send modal and the Templates
// page preview all render templates the same way. The sender placeholders are
// NOT filled here — the mailer fills those from the account that actually sends.

/** Replace every {{key}} with vars[key]; unknown placeholders become ''. */
export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? "");
}

/** Template vars that keep the sender placeholders INTACT when a body is
 *  rendered at queue time. The mailer is the single choke point that fills
 *  them (from the account that actually sends), so anything that renders a
 *  template before the send must map them back to themselves — otherwise
 *  `substitute` treats them as unknown and blanks them, and the email goes out
 *  signed with nothing. */
export function senderVars(): Record<string, string> {
  return { sender: "{{sender}}", sender_email: "{{sender_email}}" };
}

/** Template vars for the URL placeholders. {{url}} stays an alias of the
 *  Upwork link (pre-existing templates keep working); {{url_github}} falls
 *  back to the profile URL derived from the GitHub username. */
export function urlVars(links: {
  upwork?: string;
  linkedin?: string;
  github?: string;
  username?: string;
}): Record<string, string> {
  const upwork = (links.upwork ?? "").trim();
  const github =
    (links.github ?? "").trim() ||
    ((links.username ?? "").trim()
      ? `https://github.com/${(links.username ?? "").trim()}`
      : "");
  return {
    url: upwork,
    url_upwork: upwork,
    url_linkedin: (links.linkedin ?? "").trim(),
    url_github: github,
  };
}

/** The subject a Pitch or reply threads under: the Opener's own subject as
 *  "Re: …", never doubled when it already starts with "Re:". */
export function replySubject(subject: string): string {
  const s = subject.trim();
  if (!s) return "Re:";
  if (/^re:\s*/i.test(s)) return s;
  return `Re: ${s}`;
}

/** A safe first name for {{name}}: falls back to "there" when the stored name
 *  is missing or is actually a URL/email/handle that leaked into the field
 *  (so an opener never reads "Hi https://upwork.com/…"). */
export function displayName(raw: string | null | undefined): string {
  const n = (raw ?? "").trim();
  if (!n) return "there";
  if (/^https?:|:\/\/|www\.|@|\.(com|net|io|org|dev|co|me)\b/i.test(n)) {
    return "there";
  }
  if (n.length > 40) return "there";
  return n;
}
