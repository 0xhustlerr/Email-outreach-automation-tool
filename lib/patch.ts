import type { PatchAuthor } from "./types";

// Matches a mail-style author line: `From: Display Name <user@host.tld>`
// Anchored to the start of a line; multiline so we can scan a whole header block.
export const FROM_LINE_RE = /^From:\s+(.+?)\s+<([^>]+)>\s*$/m;

// A git-format-patch header ends at the first blank line before the diff body.
// We only care about that prefix for author detection, so slice cheaply.
export function extractPatchHeader(patch: string): string {
  const boundary = patch.indexOf("\n\n");
  if (boundary === -1) return patch.slice(0, 4096);
  return patch.slice(0, boundary);
}

// The commit message body - between the mail-style header's blank line and the
// stats/diff section. Scanning this (and not the diff) keeps noise low: signatures
// and sign-off lines with contact info stay, source code and fixtures are skipped.
export function extractPatchMessage(patch: string): string {
  const headerEnd = patch.indexOf("\n\n");
  if (headerEnd === -1) return "";
  const rest = patch.slice(headerEnd + 2);
  let end = rest.length;
  const statsIdx = rest.search(/\n---\n/);
  if (statsIdx !== -1) end = Math.min(end, statsIdx);
  const diffIdx = rest.search(/\ndiff --git /);
  if (diffIdx !== -1) end = Math.min(end, diffIdx);
  return rest.slice(0, end);
}

// The author's UTC offset from the git-format-patch "Date:" line, in minutes
// (e.g. "-0400" -> -240, "+0300" -> +180). This offset is the author's real
// working timezone at commit time - the strongest signal for local-time send
// scheduling. Returns null when there's no parseable offset.
export function extractCommitTzOffset(patch: string): number | null {
  const header = extractPatchHeader(patch);
  const dateLine = /^Date:\s*(.+)$/m.exec(header);
  if (!dateLine) return null;
  const off = /([+-])(\d{2})(\d{2})\b/.exec(dateLine[1]);
  if (!off) return null;
  const sign = off[1] === "-" ? -1 : 1;
  const minutes = sign * (parseInt(off[2], 10) * 60 + parseInt(off[3], 10));
  // Sanity: real offsets are within ±14h.
  return Math.abs(minutes) <= 14 * 60 ? minutes : null;
}

export function extractAuthorFromPatch(patch: string): PatchAuthor | null {
  const header = extractPatchHeader(patch);
  const match = FROM_LINE_RE.exec(header);
  if (!match) return null;
  const name = match[1].trim().replace(/^"(.*)"$/, "$1");
  const email = match[2].trim();
  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { name, email };
}

// GitHub's "Keep my email addresses private" setting rewrites the author email
// to `<id>+<login>@users.noreply.github.com`. Those are synthetic and useless
// for outreach, so we skip them. Also reject generic `noreply@` / `no-reply@`
// locals that automation services generate.
export function isPublicEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (lower.endsWith("@users.noreply.github.com")) return false;
  if (lower.endsWith(".noreply.github.com")) return false;
  const local = lower.split("@", 1)[0] ?? "";
  if (local === "noreply" || local === "no-reply") return false;
  return true;
}

