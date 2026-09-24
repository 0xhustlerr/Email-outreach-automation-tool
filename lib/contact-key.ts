// Contact keys: the primary key of the contacts table. A GitHub profile is
// keyed by its lowercased login - the same key scans save under - so a
// manually added GitHub person merges into the card a scan already made.
// Any other link is keyed by host + path.

export function keyFromUrl(
  raw: string,
): { key: string; login: string; url: string } | null {
  let input = raw.trim();
  if (!input) return null;
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  const firstSeg = u.pathname.split("/").filter(Boolean)[0] ?? "";
  if (host === "github.com" && firstSeg) {
    return { key: firstSeg.toLowerCase(), login: firstSeg, url: `https://github.com/${firstSeg}` };
  }
  const key = `${host}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
  return { key, login: firstSeg || host, url: u.toString() };
}

/** A user-typed link made clickable/storable: "https://" added when missing. */
export function withScheme(raw: string): string {
  const t = raw.trim();
  return !t || /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

/** The GitHub login in a github.com/<user> URL, or null if it isn't one. */
export function githubLogin(raw: string): string | null {
  const parsed = keyFromUrl(raw);
  if (!parsed || !/^https:\/\/github\.com\/[^/]+$/.test(parsed.url)) return null;
  return parsed.login;
}

/**
 * Key after an edit. A GitHub login re-keys the card to it - where scans save
 * that person - so a hand-made card and the scan's become one; anything else
 * keeps the key (Upwork/LinkedIn links carry no scan identity to meet).
 */
export function keyAfterEdit(currentKey: string, githubUrl: string): string {
  const login = githubUrl.trim() ? githubLogin(githubUrl) : null;
  return login ? login.toLowerCase() : currentKey;
}

/**
 * Key for a contact added by hand. GitHub login first, then the Upwork link,
 * then LinkedIn; with no link at all the contact gets a fresh `manual:` key
 * (a name alone identifies nobody, so two "John"s stay two cards).
 */
export function keyForManualContact(
  links: { githubUrl?: string; upworkUrl?: string; linkedinUrl?: string },
  newId: () => string = () => crypto.randomUUID(),
): string {
  const gh = links.githubUrl?.trim() ? githubLogin(links.githubUrl) : null;
  if (gh) return gh.toLowerCase();
  for (const url of [links.upworkUrl, links.linkedinUrl]) {
    const parsed = url?.trim() ? keyFromUrl(url) : null;
    if (parsed) return parsed.key;
  }
  return `manual:${newId()}`;
}
