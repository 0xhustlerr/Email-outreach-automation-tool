import type { CommitSummary, Repo } from "./types";
import { getGithubToken } from "./identities-store";
import { extractCommitTzOffset } from "./patch";

const API_BASE = "https://api.github.com";

function authHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "email-auto-sending-automation",
  };
  const token = getGithubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Validate a GitHub token (classic or fine-grained) by calling the API. */
export async function verifyGithubToken(
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/rate_limit`, {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "email-auto-sending-automation",
      },
    });
    if (res.status === 401) {
      return { ok: false, error: "GitHub rejected the token (401). Check you pasted it correctly." };
    }
    if (!res.ok) {
      return { ok: false, error: `GitHub returned ${res.status}.` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach GitHub." };
  }
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimited = false,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

async function ghFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const rateLimited =
      res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
    const body = await res.text().catch(() => "");
    throw new GitHubError(
      rateLimited
        ? "GitHub API rate limit exceeded. Add a GITHUB_TOKEN to .env.local to raise the limit."
        : `GitHub API error ${res.status}: ${body.slice(0, 200)}`,
      res.status,
      rateLimited,
    );
  }
  return res;
}

// Accepts any of:
//   https://github.com/sjovanovic
//   https://github.com/sjovanovic/
//   github.com/sjovanovic
//   sjovanovic
export function parseGitHubUsername(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withoutProto = trimmed.replace(/^https?:\/\//i, "");
  const withoutHost = withoutProto.replace(/^(www\.)?github\.com\/?/i, "");
  const firstSegment = withoutHost.split(/[/?#]/)[0];
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(firstSegment)
    ? firstSegment
    : null;
}

export type GitHubUser = {
  login: string;
  name: string | null;
  email: string | null;
  blog: string | null;
  bio: string | null;
  // Free-form string GitHub shows under the map-pin on the profile page.
  // Usually "City, Country" or "City-State. Country." - shape varies.
  location: string | null;
  htmlUrl: string;
};

export async function getUser(login: string): Promise<GitHubUser> {
  const res = await ghFetch(`/users/${encodeURIComponent(login)}`);
  const data = (await res.json()) as Record<string, unknown>;
  return {
    login: String(data.login ?? login),
    name: (data.name as string | null) ?? null,
    email: (data.email as string | null) ?? null,
    blog: data.blog ? String(data.blog).trim() || null : null,
    bio: (data.bio as string | null) ?? null,
    location: data.location ? String(data.location).trim() || null : null,
    htmlUrl: String(data.html_url ?? `https://github.com/${login}`),
  };
}

// GitHub's profile-sidebar "social accounts" (Twitter, LinkedIn, Mastodon,
// generic URLs like t.me/<handle>) live behind a separate endpoint and are
// not returned on the main /users/:login payload. A missing or error response
// just means the user has none / the token can't see them - callers should
// tolerate an empty list.
export async function listUserSocialAccounts(
  login: string,
): Promise<string[]> {
  try {
    const res = await ghFetch(
      `/users/${encodeURIComponent(login)}/social_accounts`,
    );
    const raw = (await res.json()) as Array<Record<string, unknown>>;
    return raw
      .map((s) => (typeof s.url === "string" ? s.url.trim() : ""))
      .filter((u) => u.length > 0);
  } catch (err) {
    if (err instanceof GitHubError && err.rateLimited) throw err;
    return [];
  }
}

export async function listUserRepos(user: string): Promise<Repo[]> {
  // `type=owner` excludes repos the user merely collaborates on;
  // `sort=pushed` surfaces recently active ones first.
  const res = await ghFetch(
    `/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed&type=owner`,
  );
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  return raw.map((r) => ({
    name: String(r.name),
    fullName: String(r.full_name),
    owner: String((r.owner as { login?: string } | null)?.login ?? user),
    fork: Boolean(r.fork),
    pushedAt: (r.pushed_at as string | null) ?? null,
    updatedAt: (r.updated_at as string | null) ?? null,
    defaultBranch: (r.default_branch as string | null) ?? null,
    htmlUrl: String(r.html_url),
  }));
}

export function pickDefaultRepo(repos: Repo[]): Repo | null {
  const candidates = repos.filter((r) => !r.fork);
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const ta = a.pushedAt ? Date.parse(a.pushedAt) : 0;
    const tb = b.pushedAt ? Date.parse(b.pushedAt) : 0;
    return tb - ta;
  })[0];
}

export async function listCommits(
  owner: string,
  repo: string,
  limit: number,
): Promise<CommitSummary[]> {
  const perPage = Math.min(Math.max(limit, 1), 100);
  const res = await ghFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/commits?per_page=${perPage}`,
  );
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  return raw.slice(0, limit).map((c) => {
    const commit =
      (c.commit as {
        message?: string;
        author?: { date?: string | null } | null;
        committer?: { date?: string | null } | null;
      } | null) ?? {};
    // Prefer author date (when the work was written); fall back to committer
    // date (when it landed) so we still show something for amended/rebased work.
    const date =
      commit.author?.date ?? commit.committer?.date ?? null;
    return {
      sha: String(c.sha),
      message: (commit.message ?? "").split("\n", 1)[0],
      htmlUrl: String(c.html_url),
      date: date ?? null,
    };
  });
}

export type CommitAuthorRecord = {
  /** Author email exactly as recorded in the commit. */
  email: string;
  name: string;
  /** Author date, NORMALIZED TO UTC by the API (no original offset - use
   *  fetchCommitTzOffset with the sha when the real offset matters). */
  date: string | null;
  sha: string;
  repo: string;
  owner: string;
};

/** Author identities on a user's own commits in one repo. The commits API
 *  already carries commit.author.{name,email,date}, so this needs ONE request
 *  per repo — no per-commit .patch downloads (see /api/scan for that heavier
 *  path). Used by the CSV import's email discovery. */
export async function listCommitAuthors(
  owner: string,
  repo: string,
  login: string,
  limit = 30,
): Promise<CommitAuthorRecord[]> {
  const perPage = Math.min(Math.max(limit, 1), 100);
  let res: Response;
  try {
    res = await ghFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits` +
        `?author=${encodeURIComponent(login)}&per_page=${perPage}`,
    );
  } catch (err) {
    // 404 (gone/private) and 409 (empty repo) are normal here; only a rate
    // limit is worth aborting the whole import for.
    if (err instanceof GitHubError && err.rateLimited) throw err;
    return [];
  }
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  const out: CommitAuthorRecord[] = [];
  for (const c of raw) {
    const commit =
      (c.commit as {
        author?: { name?: string; email?: string; date?: string } | null;
      } | null) ?? {};
    const email = (commit.author?.email ?? "").trim();
    if (!email) continue;
    out.push({
      email,
      name: (commit.author?.name ?? "").trim(),
      date: commit.author?.date ?? null,
      sha: String(c.sha ?? ""),
      repo,
      owner,
    });
  }
  return out;
}

// Enough of a .patch to cover the mail-style header block; the "Date:" line is
// within the first few hundred bytes.
const PATCH_HEADER_BYTES = 8 * 1024;

/** The author's real UTC offset for one commit, in minutes. The commits API
 *  normalizes dates to UTC, so the offset only survives in the raw .patch
 *  header — we stream it and stop after the header instead of pulling down a
 *  potentially huge diff. Null when it can't be read. */
export async function fetchCommitTzOffset(
  owner: string,
  repo: string,
  sha: string,
): Promise<number | null> {
  if (!sha) return null;
  const headers: Record<string, string> = {
    "User-Agent": "email-auto-sending-automation",
    Accept: "text/plain,*/*",
  };
  const token = getGithubToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(buildPatchUrl(owner, repo, sha), {
      headers,
      cache: "no-store",
      redirect: "follow",
      signal: ac.signal,
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let text = "";
    while (text.length < PATCH_HEADER_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      // The header ends at the first blank line — everything after is diff.
      if (text.includes("\n\n")) break;
    }
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    return extractCommitTzOffset(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function buildPatchUrl(owner: string, repo: string, sha: string): string {
  return `https://github.com/${owner}/${repo}/commit/${sha}.patch`;
}

export async function fetchPatch(url: string): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": "email-auto-sending-automation",
    Accept: "text/plain,*/*",
  };
  const token = getGithubToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers, cache: "no-store", redirect: "follow" });
  if (!res.ok) {
    throw new GitHubError(
      `Failed to fetch patch (${res.status})`,
      res.status,
      res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0",
    );
  }
  return res.text();
}
