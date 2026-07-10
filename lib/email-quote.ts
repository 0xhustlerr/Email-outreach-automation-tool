/**
 * Keeps only the newest reply text - strips Gmail/Outlook quoted thread below.
 */

export function stripQuotedReplyBody(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
  if (!text) return "";

  const cutPatterns = [
    /\nOn .+ wrote:\s*\n/i,
    /\nOn .+ at .+ wrote:\s*\n/i,
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\nFrom:\s*.+\nSent:\s/im,
    /\n_{5,}\n/,
    /\n\*From:\*/i,
  ];

  for (const pattern of cutPatterns) {
    const match = pattern.exec(text);
    if (match?.index != null && match.index > 0) {
      text = text.slice(0, match.index).trim();
    }
  }

  const lines = text.split("\n");
  const firstQuoteLine = lines.findIndex((line) => {
    const t = line.trimStart();
    return t.startsWith(">") || t.startsWith("&gt;");
  });
  if (firstQuoteLine > 0) {
    text = lines.slice(0, firstQuoteLine).join("\n").trim();
  }

  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToPlainForQuote(html: string): string {
  let t = html;
  const blockIdx = t.search(/<blockquote[\s>]/i);
  if (blockIdx > 0) t = t.slice(0, blockIdx);
  const gmailIdx = t.search(/class=["']gmail_quote["']/i);
  if (gmailIdx > 0) t = t.slice(0, gmailIdx);

  return t
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'");
}
