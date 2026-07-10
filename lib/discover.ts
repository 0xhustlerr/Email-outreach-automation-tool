import { getUser, listUserSocialAccounts } from "./github";
import { isPublicEmail } from "./patch";
import type { DiscoveryResult, DiscoverySource } from "./types";

const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const MAILTO_RE = /mailto:([^"'?\s>&]+)/gi;
const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;

// t.me / telegram.me URLs. Handle is 5–32 chars, letter-led, a-z/0-9/_.
const TELEGRAM_URL_RE =
  /https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{4,31})(?![A-Za-z0-9_])/gi;

// "Telegram: @handle" - context-gated. We require both the "telegram"/"tg"
// keyword AND an explicit `@` before the handle; without `@` this regex
// greedily matched any adjacent word (e.g. "Telegram bot tutorial" → "bot").
const TELEGRAM_CONTEXT_RE =
  /(?:\btelegram|\btg)\s*[:\-]?\s*@([A-Za-z][A-Za-z0-9_]{4,31})(?![A-Za-z0-9_])/gi;

// E.164-shaped phone: `+` followed by 8–16 chars of digits / spaces / dashes /
// parens, ending in a digit. Lookbehind refuses to match inside version strings
// like `v+1.2.3` or code like `x + 100`.
const PHONE_STRICT_RE =
  /(?<![\w.])\+[\d][\d\s\-()]{6,18}\d(?![\w])/g;

// tel:+1234 links and wa.me/<number> links.
const TEL_SCHEME_RE = /tel:\s*(\+?[\d\s\-()]{7,20})/gi;
const WA_URL_RE = /https?:\/\/(?:www\.)?wa\.me\/(\+?\d{7,15})/gi;

const MAX_README_LINKS = 6;

// Hosts that almost always appear in READMEs but aren't personal sites -
// badges, social profiles, package registries, platform docs.
const NON_PERSONAL_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "gist.github.com",
  "docs.github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "user-images.githubusercontent.com",
  "camo.githubusercontent.com",
  "avatars.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "img.shields.io",
  "shields.io",
  "badgen.net",
  "badge.fury.io",
  "codecov.io",
  "coveralls.io",
  "travis-ci.org",
  "travis-ci.com",
  "circleci.com",
  "npmjs.com",
  "www.npmjs.com",
  "pypi.org",
  "crates.io",
  "hub.docker.com",
  "twitter.com",
  "www.twitter.com",
  "x.com",
  "www.x.com",
  "linkedin.com",
  "www.linkedin.com",
  "facebook.com",
  "www.facebook.com",
  "instagram.com",
  "www.instagram.com",
  "youtube.com",
  "www.youtube.com",
  "youtu.be",
  "medium.com",
  "dev.to",
  "stackoverflow.com",
  "reddit.com",
  "www.reddit.com",
  "t.me",
  "discord.gg",
  "discord.com",
  "wa.me",
]);

const ASSET_EXT =
  /\.(png|jpe?g|gif|svg|webp|ico|bmp|mp3|mp4|mov|avi|zip|tar|gz|exe|dmg|pdf)(\?|#|$)/i;

const FETCH_HEADERS: HeadersInit = {
  "User-Agent":
    "email-auto-sending-automation/1.0 (+https://github.com/anthropics/claude-code)",
  Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
};
const MAX_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

function uniquePublicEmails(emails: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const raw of emails) {
    const cleaned = raw.trim().toLowerCase();
    if (!cleaned) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) continue;
    if (!isPublicEmail(cleaned)) continue;
    seen.add(cleaned);
  }
  return [...seen];
}

export function extractEmails(text: string): string[] {
  if (!text) return [];
  return uniquePublicEmails(text.match(EMAIL_RE) ?? []);
}

export function extractMailtoEmails(html: string): string[] {
  if (!html) return [];
  const found: string[] = [];
  for (const m of html.matchAll(MAILTO_RE)) found.push(decodeURIComponent(m[1]));
  return uniquePublicEmails(found);
}

// Telegram reserves these for its own pages, so `t.me/share` ≠ a username.
const TELEGRAM_RESERVED = new Set([
  "share",
  "joinchat",
  "addstickers",
  "proxy",
  "socks",
  "bg",
  "setlanguage",
  "confirmphone",
  "iv",
  "login",
  "start",
]);

export function extractTelegrams(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(TELEGRAM_URL_RE)) {
    const h = m[1].toLowerCase();
    if (!TELEGRAM_RESERVED.has(h)) out.add(h);
  }
  for (const m of text.matchAll(TELEGRAM_CONTEXT_RE)) {
    const h = m[1].toLowerCase();
    if (!TELEGRAM_RESERVED.has(h)) out.add(h);
  }
  return [...out];
}

function normalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/[^\d+]/g, "");
  if (!cleaned.startsWith("+")) return null;
  const digits = cleaned.slice(1);
  if (digits.length < 7 || digits.length > 15) return null;
  return "+" + digits;
}

export function extractPhones(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(PHONE_STRICT_RE)) {
    const n = normalizePhone(m[0]);
    if (n) out.add(n);
  }
  for (const m of text.matchAll(TEL_SCHEME_RE)) {
    const v = m[1].startsWith("+") ? m[1] : "+" + m[1];
    const n = normalizePhone(v);
    if (n) out.add(n);
  }
  for (const m of text.matchAll(WA_URL_RE)) {
    const v = m[1].startsWith("+") ? m[1] : "+" + m[1];
    const n = normalizePhone(v);
    if (n) out.add(n);
  }
  return [...out];
}

export function extractUrls(text: string): string[] {
  if (!text) return [];
  const urls = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    urls.add(m[0].replace(/[.,;:!?]+$/, ""));
  }
  return [...urls];
}

export function isLikelyPersonalSite(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (NON_PERSONAL_HOSTS.has(host)) return false;
  if (ASSET_EXT.test(u.pathname)) return false;
  return true;
}

// SSRF guard: the `blog` field is user-controlled, so we refuse to fetch
// loopback / link-local / RFC1918 hosts. Public DNS rebinding isn't covered;
// for that we'd need to resolve the hostname server-side and re-check the IP.
function isPublicHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (!host || host === "localhost" || host === "0.0.0.0") return false;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [, aS, bS] = ipv4;
    const a = Number(aS);
    const b = Number(bS);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  if (host === "::1") return false;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd"))
    return false;
  return true;
}

export async function fetchText(url: string): Promise<string | null> {
  if (!isPublicHttpUrl(url)) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
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

async function fetchProfileReadme(
  login: string,
): Promise<{ url: string; text: string } | null> {
  // Convention: `<login>/<login>` is the special "profile" repo whose README
  // renders on the user's profile page. Try the two default branches GitHub
  // initializes; HEAD usually works but some older repos still use master.
  for (const branch of ["HEAD", "main", "master"]) {
    const raw = `https://raw.githubusercontent.com/${login}/${login}/${branch}/README.md`;
    const text = await fetchText(raw);
    if (text) return { url: `https://github.com/${login}/${login}`, text };
  }
  return null;
}

function normalizeBlog(blog: string | null): string | null {
  if (!blog) return null;
  const trimmed = blog.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export async function discoverEmails(login: string): Promise<DiscoveryResult> {
  const user = await getUser(login);
  const blog = normalizeBlog(user.blog);

  // Run README + blog fetches and social-accounts lookup in parallel. The
  // profile email is already in `user`; social-accounts is where Telegram /
  // LinkedIn / Mastodon sidebar links live - it's a separate GH endpoint.
  const [readme, blogHtml, socialAccounts] = await Promise.all([
    fetchProfileReadme(login).catch(() => null),
    blog ? fetchText(blog).catch(() => null) : Promise.resolve(null),
    listUserSocialAccounts(login).catch(() => [] as string[]),
  ]);

  const sources: DiscoverySource[] = [];

  // GitHub profile public fields. Bio sometimes contains a Telegram or phone;
  // social_accounts sidebar URLs (t.me/<handle>, wa.me/<num>, etc.) go in here
  // too so the regexes pick them up.
  const profileBlob = [
    user.bio ?? "",
    user.blog ?? "",
    ...socialAccounts,
  ].join("\n");
  const profileEmails =
    user.email && isPublicEmail(user.email) ? [user.email.toLowerCase()] : [];
  const profileTelegrams = extractTelegrams(profileBlob);
  const profilePhones = extractPhones(profileBlob);
  if (profileEmails.length || profileTelegrams.length || profilePhones.length) {
    sources.push({
      kind: "profile",
      label: "GitHub profile",
      url: user.htmlUrl,
      emails: profileEmails,
      telegrams: profileTelegrams,
      phones: profilePhones,
    });
  }

  if (readme) {
    const found = uniquePublicEmails([
      ...extractEmails(readme.text),
      ...extractMailtoEmails(readme.text),
    ]);
    const tels = extractTelegrams(readme.text);
    const phs = extractPhones(readme.text);
    sources.push({
      kind: "readme",
      label: "Profile README",
      url: readme.url,
      emails: found,
      telegrams: tels,
      phones: phs,
      note:
        found.length + tels.length + phs.length === 0
          ? "No contacts detected in README."
          : undefined,
    });

    // Follow outbound links that look like personal sites and scrape each for
    // contact addresses. Cap the count so a link-heavy README can't stall the
    // whole request, and skip anything that's already the user's `blog` URL.
    const readmeLinks = extractUrls(readme.text)
      .filter(isLikelyPersonalSite)
      .filter((u) => !blog || new URL(u).hostname !== new URL(blog).hostname)
      .slice(0, MAX_README_LINKS);

    const linked = await Promise.all(
      readmeLinks.map(async (url) => {
        const html = await fetchText(url);
        if (!html) return null;
        const emails = uniquePublicEmails([
          ...extractEmails(html),
          ...extractMailtoEmails(html),
        ]);
        const telegrams = extractTelegrams(html);
        const phones = extractPhones(html);
        return { url, emails, telegrams, phones };
      }),
    );

    for (const link of linked) {
      if (
        !link ||
        link.emails.length + link.telegrams.length + link.phones.length === 0
      )
        continue;
      let host = link.url;
      try {
        host = new URL(link.url).hostname;
      } catch {
        /* keep original */
      }
      sources.push({
        kind: "readme-link",
        label: `Linked from README (${host})`,
        url: link.url,
        emails: link.emails,
        telegrams: link.telegrams,
        phones: link.phones,
      });
    }
  }

  if (blog) {
    if (blogHtml) {
      const found = uniquePublicEmails([
        ...extractEmails(blogHtml),
        ...extractMailtoEmails(blogHtml),
      ]);
      const tels = extractTelegrams(blogHtml);
      const phs = extractPhones(blogHtml);
      sources.push({
        kind: "blog",
        label: "Personal website",
        url: blog,
        emails: found,
        telegrams: tels,
        phones: phs,
        note:
          found.length + tels.length + phs.length === 0
            ? "No contacts detected on the page."
            : undefined,
      });
    } else {
      sources.push({
        kind: "blog",
        label: "Personal website",
        url: blog,
        emails: [],
        telegrams: [],
        phones: [],
        note: "Couldn't fetch the page (timeout, redirect, or blocked).",
      });
    }
  }

  return {
    login: user.login,
    name: user.name,
    blog,
    location: user.location,
    sources,
  };
}
