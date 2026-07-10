// Stack Overflow user profile URL:  https://stackoverflow.com/users/<id>/<slug>
// `meta.stackoverflow.com` and the Network sites share the same /users/<id>
// shape; we only claim support for the main site here.
const SO_USER_RE =
  /^https?:\/\/(www\.)?stackoverflow\.com\/users\/\d+(\/[^/?#]*)?\/?/i;

// Matches an absolute or protocol-relative GitHub user URL anywhere in HTML.
const GITHUB_USERNAME_RE =
  /(?:https?:)?\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:[/?#"'\s<]|$)/gi;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 12_000;

// GitHub reserves these path prefixes for its own pages, so
// `github.com/explore` is never a username - skip them.
const RESERVED_LOGINS = new Set([
  "about",
  "apps",
  "business",
  "codespaces",
  "collections",
  "contact",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "githubtraining",
  "home",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "readme",
  "search",
  "security",
  "settings",
  "signup",
  "site",
  "sponsors",
  "stars",
  "team",
  "topics",
  "trending",
]);

export function isStackOverflowUrl(input: string): boolean {
  return SO_USER_RE.test(input.trim());
}

// Pick the GitHub login that shows up most often in the HTML. SO pages also
// reference the Stack Overflow / gh-issue-sync GitHub orgs in footer links, so
// we need more than "first match wins" to avoid picking those up.
export async function findGitHubLoginFromStackOverflow(
  url: string,
): Promise<string | null> {
  const html = await fetchSoPage(url);
  if (!html) return null;

  const counts = new Map<string, number>();
  for (const match of html.matchAll(GITHUB_USERNAME_RE)) {
    const login = match[1];
    if (RESERVED_LOGINS.has(login.toLowerCase())) continue;
    counts.set(login, (counts.get(login) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  // Highest count wins; ties broken by first-seen order (Map preserves it).
  let best: string | null = null;
  let bestCount = -1;
  for (const [login, n] of counts) {
    if (n > bestCount) {
      best = login;
      bestCount = n;
    }
  }
  return best;
}

async function fetchSoPage(url: string): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: ac.signal,
    });
    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (received >= MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
    const buf = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      buf.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
