// The email search engine behind the CSV import: given a GitHub profile, pull
// every address the person exposes, then let lib/email-score.ts pick the one
// they actually read today (plus an optional CC).
//
// Two sources of signal:
//   1. discoverEmails()  - profile field, profile README, personal site, and
//                          personal sites linked from the README (lib/discover.ts)
//   2. commit authorship - the address on their own recent commits, which is
//                          the strongest "still in use" evidence we can get
//
// Commit authorship comes from the commits API (one request per repo), not the
// per-commit .patch downloads /api/scan uses - same data, a fraction of the cost.

import {
  fetchCommitTzOffset,
  getUser,
  listCommitAuthors,
  listUserRepos,
  type CommitAuthorRecord,
} from "./github";
import { discoverEmails } from "./discover";
import {
  scoreEmails,
  type EmailChoice,
  type EmailSignal,
  type EmailSourceKind,
} from "./email-score";

/** How many of the user's most recently pushed non-fork repos to inspect. */
const REPO_LIMIT = 5;
/** Commits pulled per repo (their own only — the API filters by author). */
const COMMITS_PER_REPO = 30;

export type LeadDiscovery = {
  login: string;
  /** GitHub display name, or "" — used as the fallback greeting name. */
  name: string;
  /** Raw free-form GitHub location (may be ""). */
  location: string;
  profileUrl: string;
  blogHost: string | null;
  phones: string[];
  telegrams: string[];
  /** Representative commit UTC offset in minutes, for local-time scheduling. */
  commitOffsetMin: number | null;
  /** Commits actually inspected (the denominator for the usage-share score). */
  totalCommits: number;
  choice: EmailChoice;
};

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

// discover.ts labels its sources with the same vocabulary the scorer uses,
// except "readme-link" needs no mapping — keep this explicit so an added
// source kind over there fails loudly here instead of silently scoring 0.
function toSourceKind(kind: string): EmailSourceKind | null {
  switch (kind) {
    case "profile":
      return "profile";
    case "readme":
      return "readme";
    case "readme-link":
      return "readme-link";
    case "blog":
      return "blog";
    default:
      return null;
  }
}

/** Gather every contact signal for a GitHub login and choose the best email. */
export async function discoverLeadEmails(login: string): Promise<LeadDiscovery> {
  const [user, discovery] = await Promise.all([getUser(login), discoverEmails(login)]);

  // Their own commits across the most recently pushed non-fork repos.
  let commits: CommitAuthorRecord[] = [];
  try {
    const repos = (await listUserRepos(user.login))
      .filter((r) => !r.fork)
      .slice(0, REPO_LIMIT);
    const perRepo = await Promise.all(
      repos.map((r) =>
        listCommitAuthors(r.owner, r.name, user.login, COMMITS_PER_REPO),
      ),
    );
    commits = perRepo.flat();
  } catch {
    // No repos / all private / transient failure — profile signals still stand.
    // (A rate limit propagates from discoverEmails above, which runs first.)
  }

  // Fold commit authorship into per-address stats.
  const byEmail = new Map<string, EmailSignal>();
  const touch = (rawEmail: string, kind: EmailSourceKind): EmailSignal => {
    const email = rawEmail.trim().toLowerCase();
    let s = byEmail.get(email);
    if (!s) {
      s = { email, sources: [], commitCount: 0, lastCommitAt: null };
      byEmail.set(email, s);
    }
    if (!s.sources.includes(kind)) s.sources.push(kind);
    return s;
  };

  for (const c of commits) {
    const s = touch(c.email, "commit");
    s.commitCount++;
    if (c.date && (!s.lastCommitAt || Date.parse(c.date) > Date.parse(s.lastCommitAt))) {
      s.lastCommitAt = c.date;
    }
  }

  for (const source of discovery.sources) {
    const kind = toSourceKind(source.kind);
    if (!kind) continue;
    for (const email of source.emails) touch(email, kind);
  }

  const phones = [...new Set(discovery.sources.flatMap((s) => s.phones))];
  const telegrams = [...new Set(discovery.sources.flatMap((s) => s.telegrams))];

  const blogHost = hostOf(discovery.blog);
  const choice = scoreEmails({
    login: user.login,
    name: user.name ?? "",
    blogHost,
    totalCommits: commits.length,
    signals: [...byEmail.values()],
  });

  // Their working timezone, for local-time send scheduling. The commits API
  // normalizes dates to UTC, so read the real offset off the raw patch header
  // of ONE commit - the newest by the address we actually chose, since that's
  // the machine they work from today.
  const newest = commits
    .filter((c) =>
      choice.best ? c.email.toLowerCase() === choice.best.email : true,
    )
    .sort((a, b) => Date.parse(b.date ?? "") - Date.parse(a.date ?? ""))[0];
  const commitOffsetMin = newest
    ? await fetchCommitTzOffset(newest.owner, newest.repo, newest.sha)
    : null;

  return {
    login: user.login,
    name: user.name ?? "",
    location: discovery.location ?? user.location ?? "",
    profileUrl: user.htmlUrl,
    blogHost,
    phones,
    telegrams,
    commitOffsetMin,
    totalCommits: commits.length,
    choice,
  };
}
