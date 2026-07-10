import type { CommitSummary, Repo } from "./types";
import { getGithubToken } from "./identities-store";

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
