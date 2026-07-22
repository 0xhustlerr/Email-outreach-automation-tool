// Which of a developer's discovered addresses should we actually write to?
//
// A GitHub footprint usually surfaces several: the profile field, the address
// on their recent commits, one on a personal site, a stale one from an old
// repo. This module scores every candidate and picks the ONE they most likely
// read today - plus, when a runner-up scores nearly as high, a second address
// to CC so a near-tie doesn't cost us the contact.
//
// Recency is weighted heavily on purpose: an address they committed with last
// month beats one they published on a site five years ago.

import { isPublicEmail } from "./patch";

export type EmailSourceKind =
  | "profile"
  | "commit"
  | "blog"
  | "readme"
  | "readme-link";

/** One address before scoring, as gathered by lib/lead-discovery.ts. */
export type EmailSignal = {
  email: string;
  sources: EmailSourceKind[];
  /** How many of the author's scanned commits used this address. */
  commitCount: number;
  /** Most recent commit (ISO) that used it, if any. */
  lastCommitAt: string | null;
};

export type EmailCandidate = EmailSignal & {
  score: number;
  /** Human-readable score breakdown, shown in the import log. */
  reasons: string[];
};

export type EmailChoice = {
  best: EmailCandidate | null;
  /** Runner-up worth CC'ing, or null. */
  cc: EmailCandidate | null;
  /** Every scored candidate, best first. */
  candidates: EmailCandidate[];
  /** Why `best` is null (empty when we picked one). */
  reason: string;
};

// Score a candidate must clear to be written to at all.
const MIN_SCORE = 35;
// A runner-up this close to the winner gets CC'd instead of dropped.
const CC_RATIO = 0.85;

const FREEMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "aol.com",
  "gmx.com",
  "gmx.de",
  "web.de",
  "mail.com",
  "mail.ru",
  "yandex.ru",
  "yandex.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
  "outlook.fr",
  "outlook.de",
  "libero.it",
  "orange.fr",
  "free.fr",
  "wp.pl",
  "onet.pl",
  "seznam.cz",
]);

const DISPOSABLE = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "throwawaymail.com",
  "yopmail.com",
  "trashmail.com",
  "getnada.com",
  "sharklasers.com",
  "maildrop.cc",
  "dispostable.com",
]);

const ROLE_LOCALS = new Set([
  "info",
  "admin",
  "administrator",
  "support",
  "contact",
  "hello",
  "hi",
  "team",
  "sales",
  "help",
  "office",
  "billing",
  "careers",
  "jobs",
  "webmaster",
  "postmaster",
  "abuse",
  "marketing",
  "press",
  "legal",
  "security",
]);

// Addresses that are never a human's inbox: CI robots, package publishers,
// documentation placeholders.
const BOT_LOCAL_RE =
  /^(?:noreply|no-reply|donotreply|do-not-reply|actions|github-actions|dependabot|renovate|greenkeeper|snyk-bot|bot|ci|cd|build|jenkins|travis|circleci|codecov|semantic-release|release-bot|automated|auto|mailer-daemon|root|nobody|git|www-data)$/i;
const BOT_SUFFIX_RE = /(?:\[bot\]|-bot|_bot|\+bot)$/i;
const PLACEHOLDER_LOCAL_RE =
  /^(?:you|your|youremail|yourname|user|username|name|email|e-mail|mail|test|testing|example|sample|foo|bar|baz|demo|changeme|todo|xxx|abc|asdf|qwerty|123|a|b|x)$/i;
const PLACEHOLDER_DOMAIN_RE =
  /^(?:example\.(?:com|org|net)|domain\.com|email\.com|yourdomain\.[a-z]+|yoursite\.[a-z]+|mysite\.[a-z]+|website\.com|test\.com|sample\.com|company\.com|localhost|.*\.local|.*\.internal|.*\.test|.*\.invalid|.*\.example)$/i;

// Social handles are written `@user@instance` (Mastodon) or scraped out of
// profile links, so they reach us looking exactly like addresses — but nothing
// is deliverable there. Covers the named hosts plus the mastodon.*/mstdn.*
// instance families.
const SOCIAL_HOST_RE =
  /^(?:mastodon\.[a-z.]+|mstdn\.[a-z.]+|fosstodon\.org|hachyderm\.io|infosec\.exchange|techhub\.social|toot\.[a-z.]+|social\.[a-z.]+|twitter\.com|x\.com|t\.me|telegram\.org|discord(?:app)?\.com|bsky\.social|matrix\.org|threads\.net|instagram\.com|facebook\.com|linkedin\.com|youtube\.com|reddit\.com|medium\.com|dev\.to)$/i;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function localOf(email: string): string {
  return email.slice(0, email.lastIndexOf("@"));
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** Is this address structurally unusable (bot, placeholder, disposable host)? */
export function isRejectedEmail(raw: string): boolean {
  const email = raw.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(email)) return true;
  if (!isPublicEmail(email)) return true; // GitHub noreply & friends
  const local = localOf(email);
  const domain = domainOf(email);
  if (BOT_LOCAL_RE.test(local) || BOT_SUFFIX_RE.test(local)) return true;
  if (PLACEHOLDER_LOCAL_RE.test(local)) return true;
  if (PLACEHOLDER_DOMAIN_RE.test(domain)) return true;
  if (DISPOSABLE.has(domain)) return true;
  if (SOCIAL_HOST_RE.test(domain)) return true;
  // Vendor/product mailboxes that show up in READMEs but aren't the author.
  if (domain === "github.com" || domain === "npmjs.com") return true;
  return false;
}

/** Identity key used to merge one person's spellings of the same mailbox:
 *  Gmail ignores dots and everything after a `+`, so `a.b+x@gmail.com` and
 *  `ab@gmail.com` are the same inbox and must not be picked as To *and* Cc. */
export function mailboxKey(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(email)) return email;
  let local = localOf(email);
  const domain = domainOf(email);
  local = local.split("+", 1)[0];
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    return `${local}@gmail.com`;
  }
  return `${local}@${domain}`;
}

const SOURCE_BASE: Record<EmailSourceKind, number> = {
  profile: 45,
  commit: 40,
  blog: 30,
  readme: 25,
  "readme-link": 15,
};

const SOURCE_LABEL: Record<EmailSourceKind, string> = {
  profile: "GitHub profile field",
  commit: "commit author",
  blog: "personal site",
  readme: "profile README",
  "readme-link": "site linked from README",
};

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / 86_400_000);
}

// Name/login tokens the local part might echo ("wael", "wtaaffe", "w.taaffe").
function identityTokens(login: string, name: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const t = s.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (t.length >= 3) out.add(t);
  };
  add(login);
  for (const part of (name ?? "").split(/\s+/)) add(part);
  return [...out];
}

function normalizedLocal(email: string): string {
  return localOf(email)
    .split("+", 1)[0]
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function scoreOne(
  signal: EmailSignal,
  ctx: {
    login: string;
    name: string;
    blogHost: string | null;
    totalCommits: number;
    /** Domains seen ONLY on README-linked third-party pages. */
    linkOnlyDomains: Set<string>;
  },
): EmailCandidate {
  const email = signal.email.trim().toLowerCase();
  const domain = domainOf(email);
  const reasons: string[] = [];
  let score = 0;

  // 1. Strongest source it appeared in.
  const base = Math.max(...signal.sources.map((s) => SOURCE_BASE[s] ?? 0), 0);
  const bestSource = signal.sources.reduce<EmailSourceKind | null>(
    (acc, s) => (acc === null || SOURCE_BASE[s] > SOURCE_BASE[acc] ? s : acc),
    null,
  );
  score += base;
  if (bestSource) reasons.push(`${SOURCE_LABEL[bestSource]} (+${base})`);

  // 2. Recency — the point of the whole exercise: do they still use it?
  const age = daysSince(signal.lastCommitAt);
  if (age !== null) {
    let pts = 0;
    if (age <= 30) pts = 30;
    else if (age <= 90) pts = 22;
    else if (age <= 180) pts = 14;
    else if (age <= 365) pts = 6;
    else if (age > 730) pts = -12;
    if (pts !== 0) {
      score += pts;
      const label =
        age <= 30
          ? "committed in the last 30 days"
          : age <= 90
            ? "committed in the last 3 months"
            : age <= 180
              ? "committed in the last 6 months"
              : age <= 365
                ? "committed in the last year"
                : "not used in 2+ years";
      reasons.push(`${label} (${pts > 0 ? "+" : ""}${pts})`);
    }
  }

  // 3. How much of their commit history uses it.
  if (signal.commitCount > 0 && ctx.totalCommits > 0) {
    const share = signal.commitCount / ctx.totalCommits;
    const pts = Math.round(20 * share);
    if (pts > 0) {
      score += pts;
      reasons.push(`${Math.round(share * 100)}% of scanned commits (+${pts})`);
    }
  }

  // 4. Does the local part look like this person?
  const local = normalizedLocal(email);
  const tokens = identityTokens(ctx.login, ctx.name);
  if (tokens.some((t) => local.includes(t) || t.includes(local))) {
    score += 12;
    reasons.push("local part matches their name/login (+12)");
  }

  // 5. Domain quality.
  const blogHost = (ctx.blogHost ?? "").replace(/^www\./, "").toLowerCase();
  if (blogHost && (domain === blogHost || blogHost.endsWith(`.${domain}`))) {
    score += 12;
    reasons.push("own domain, matches their site (+12)");
  } else if (FREEMAIL.has(domain)) {
    score += 6;
    reasons.push("mainstream mailbox provider (+6)");
  } else if (tokens.some((t) => domain.replace(/[^a-z0-9]/g, "").includes(t))) {
    score += 12;
    reasons.push("personal domain (+12)");
  }

  // 6. Corroboration across independent places.
  if (new Set(signal.sources).size >= 2) {
    score += 10;
    reasons.push("found in 2+ independent places (+10)");
  }

  // 7. Penalties.
  if (ROLE_LOCALS.has(localOf(email).split("+", 1)[0])) {
    score -= 12;
    reasons.push("role address, not a personal inbox (-12)");
  }
  if (ctx.linkOnlyDomains.has(domain)) {
    score -= 10;
    reasons.push("only seen on a third-party page (-10)");
  }

  return {
    ...signal,
    email,
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
  };
}

/** Score every candidate and choose the address to write to (plus an optional
 *  CC when the runner-up is within CC_RATIO of the winner). */
export function scoreEmails(input: {
  login: string;
  name?: string | null;
  blogHost?: string | null;
  totalCommits: number;
  signals: EmailSignal[];
}): EmailChoice {
  // Merge spellings of the same mailbox before scoring, keeping the most
  // recently used one as the address we'd actually send to.
  const merged = new Map<string, EmailSignal>();
  for (const s of input.signals) {
    const email = s.email.trim().toLowerCase();
    if (!email || isRejectedEmail(email)) continue;
    const key = mailboxKey(email);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...s, email });
      continue;
    }
    const prevAge = Date.parse(prev.lastCommitAt ?? "") || 0;
    const curAge = Date.parse(s.lastCommitAt ?? "") || 0;
    merged.set(key, {
      email: curAge > prevAge ? email : prev.email,
      sources: [...new Set([...prev.sources, ...s.sources])],
      commitCount: prev.commitCount + s.commitCount,
      lastCommitAt: curAge > prevAge ? s.lastCommitAt : prev.lastCommitAt,
    });
  }

  if (merged.size === 0) {
    return { best: null, cc: null, candidates: [], reason: "no usable email found" };
  }

  // Domains that ONLY ever showed up on a README-linked page are probably some
  // third party's (a client, a sponsor), not the developer's own.
  const linkOnlyDomains = new Set<string>();
  for (const s of merged.values()) {
    const kinds = new Set(s.sources);
    if (kinds.size === 1 && kinds.has("readme-link")) {
      linkOnlyDomains.add(domainOf(s.email));
    }
  }

  const ctx = {
    login: input.login,
    name: input.name ?? "",
    blogHost: input.blogHost ?? null,
    totalCommits: input.totalCommits,
    linkOnlyDomains,
  };
  const candidates = [...merged.values()]
    .map((s) => scoreOne(s, ctx))
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score < MIN_SCORE) {
    return {
      best: null,
      cc: null,
      candidates,
      reason: best
        ? `best candidate ${best.email} scored ${best.score} (min ${MIN_SCORE})`
        : "no usable email found",
    };
  }

  const runnerUp = candidates[1];
  const cc =
    runnerUp &&
    runnerUp.score >= MIN_SCORE &&
    runnerUp.score >= best.score * CC_RATIO &&
    mailboxKey(runnerUp.email) !== mailboxKey(best.email)
      ? runnerUp
      : null;

  return { best, cc, candidates, reason: "" };
}
